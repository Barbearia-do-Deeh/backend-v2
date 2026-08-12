// api/enviar-lembretes.js
// GET /api/enviar-lembretes?secret=SEU_CRON_SECRET
// Chamado periodicamente (ex: a cada 15 min) por um gatilho externo (cron-job.org),
// já que o Cron nativo da Vercel no plano gratuito só roda 1x/dia.
//
// Verifica agendamentos do Google Calendar que começam daqui a ~3h (REMINDER_HOURS)
// e dispara push notification pro cliente, evitando duplicar via tabela lembretes_enviados.

const { google } = require('googleapis');
const webpush = require('web-push');
const pool = require('../lib/db');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || 'davidlucas261210@gmail.com';
const CRON_SECRET = process.env.CRON_SECRET;
const REMINDER_HOURS = parseFloat(process.env.REMINDER_HOURS || '3');
const INTERVAL_MINUTES = parseFloat(process.env.CRON_INTERVAL_MINUTES || '15');
const AVALIACAO_HORAS_APOS = parseFloat(process.env.AVALIACAO_HORAS_APOS || '1');
const REVIEW_URL = 'https://share.google/zfVJVDrPgBTdu0j6u';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@barbeariadodeeh.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function parseDescricao(desc) {
  const result = { telefone: null };
  if (!desc) return result;
  const tel = desc.match(/WhatsApp:\s*(.+)/);
  if (tel) result.telefone = tel[1].trim().replace(/\D/g, '');
  return result;
}

function parseNomeServico(summary) {
  const partes = (summary || '').split(' — ');
  const nome = partes.length > 1 ? partes[1].trim() : '';
  const servico = partes.length > 0 ? partes[0].replace(/^[^\p{L}]+/u, '').trim() : (summary || '');
  return { nome, servico };
}

module.exports = async (req, res) => {
  // CORS: necessário pro admin.html chamar o modo "broadcast" direto do navegador
  // (o cron-job.org, que chama o modo padrão, não precisa disso, mas não atrapalha)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Proteção simples: só executa quem souber o secret
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Não autorizado' });
  }

  // Modo notificação manual (enviado pelo admin.html)
  if (req.query.tipo === 'broadcast') {
    return enviarBroadcast(req, res);
  }

  // Modo avaliação pós-atendimento (chamado pelo cron, igual ao lembrete)
  if (req.query.tipo === 'avaliacao') {
    return enviarAvaliacoes(req, res);
  }

  try {
    const agora = new Date();
    const janelaInicio = new Date(agora.getTime() + REMINDER_HOURS * 60 * 60 * 1000);
    const janelaFim = new Date(janelaInicio.getTime() + (INTERVAL_MINUTES + 5) * 60 * 1000);

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: janelaInicio.toISOString(),
      timeMax: janelaFim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    let enviados = 0;
    let pulados = 0;
    const erros = [];

    for (const ev of eventos) {
      if (!ev.start?.dateTime) continue; // ignora eventos de dia inteiro

      // Já enviou lembrete pra esse evento?
      const jaEnviado = await pool.query(
        'SELECT 1 FROM lembretes_enviados WHERE event_id = $1',
        [ev.id]
      );
      if (jaEnviado.rows.length > 0) { pulados++; continue; }

      const { telefone } = parseDescricao(ev.description);
      const { nome, servico } = parseNomeServico(ev.summary);
      if (!telefone) { continue; }

      const subRow = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
        [telefone]
      );
      if (subRow.rows.length === 0) continue; // cliente não tem inscrição de push

      const horaEvento = new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });

      const payload = JSON.stringify({
        title: 'Barbearia do Deeh',
        body: `${nome ? nome + ', seu' : 'Seu'} horário de ${servico || 'atendimento'} é hoje às ${horaEvento}. Te esperamos!`,
        icon: '/icon-192.png',
      });

      try {
        await webpush.sendNotification(subRow.rows[0].subscription, payload);
        await pool.query(
          'INSERT INTO lembretes_enviados (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [ev.id]
        );
        enviados++;
      } catch (pushErr) {
        // Inscrição expirada/inválida — registra mas não trava o restante
        erros.push({ telefone, erro: pushErr.message });
      }
    }

    return res.status(200).json({
      success: true,
      verificados: eventos.length,
      enviados,
      pulados,
      erros,
    });
  } catch (err) {
    console.error('Erro ao enviar lembretes:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

// ---- Notificação manual (broadcast) ----
// POST /api/enviar-lembretes?tipo=broadcast&secret=SEU_CRON_SECRET
// Body: { titulo, mensagem, filtro: 'todos' | 'plano' | 'manual', valor }
//   filtro 'todos'  -> valor ignorado, manda pra todo mundo inscrito em push
//   filtro 'plano'  -> valor = 'essencial' | 'classico' | 'empresario'
//   filtro 'manual' -> valor = array de telefones (ex: ['5519999999999', ...])
async function enviarBroadcast(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Use POST para enviar notificações manuais' });
  }

  try {
    const { titulo, mensagem, filtro, valor } = req.body || {};

    if (!mensagem || !mensagem.trim()) {
      return res.status(400).json({ success: false, error: 'Mensagem é obrigatória' });
    }

    let telefones = [];

    if (filtro === 'manual') {
      if (!Array.isArray(valor) || !valor.length) {
        return res.status(400).json({ success: false, error: 'Selecione ao menos um cliente' });
      }
      telefones = valor.map((t) => String(t).replace(/\D/g, ''));
    } else if (filtro === 'plano') {
      if (!valor) {
        return res.status(400).json({ success: false, error: 'Informe o plano' });
      }
      const result = await pool.query('SELECT telefone FROM clientes WHERE plano = $1', [valor]);
      telefones = result.rows.map((r) => r.telefone);
    } else {
      // 'todos' — todo mundo que já se inscreveu pra push
      const result = await pool.query('SELECT telefone FROM push_subscriptions');
      telefones = result.rows.map((r) => r.telefone);
    }

    if (!telefones.length) {
      return res.status(200).json({
        success: true,
        selecionados: 0,
        inscritos_encontrados: 0,
        enviados: 0,
        erros: [],
        aviso: 'Nenhum destinatário encontrado para esse filtro.',
      });
    }

    const subsResult = await pool.query(
      'SELECT telefone, subscription FROM push_subscriptions WHERE telefone = ANY($1)',
      [telefones]
    );

    const payload = JSON.stringify({
      title: (titulo && titulo.trim()) || 'Barbearia do Deeh',
      body: mensagem.trim(),
      icon: '/icon-192.png',
    });

    let enviados = 0;
    const erros = [];

    for (const row of subsResult.rows) {
      try {
        await webpush.sendNotification(row.subscription, payload);
        enviados++;
      } catch (pushErr) {
        erros.push({ telefone: row.telefone, erro: pushErr.message });
      }
    }

    return res.status(200).json({
      success: true,
      selecionados: telefones.length,
      inscritos_encontrados: subsResult.rows.length,
      enviados,
      erros,
    });
  } catch (err) {
    console.error('Erro no broadcast de notificação:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

// ---- Avaliação pós-atendimento ----
// GET /api/enviar-lembretes?tipo=avaliacao&secret=SEU_CRON_SECRET
// Mesmo mecanismo do lembrete de agendamento, só que olhando pra trás: busca
// agendamentos que começaram há ~AVALIACAO_HORAS_APOS (padrão 1h) e manda um
// push pedindo avaliação, com link direto pro Google Review. Dedupe via
// tabela avaliacoes_enviadas (mesmo padrão de lembretes_enviados).
async function enviarAvaliacoes(req, res) {
  try {
    const agora = new Date();
    const janelaFim = new Date(agora.getTime() - AVALIACAO_HORAS_APOS * 60 * 60 * 1000);
    const janelaInicio = new Date(janelaFim.getTime() - (INTERVAL_MINUTES + 5) * 60 * 1000);

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: janelaInicio.toISOString(),
      timeMax: janelaFim.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    let enviados = 0;
    let pulados = 0;
    const erros = [];

    for (const ev of eventos) {
      if (!ev.start?.dateTime) continue; // ignora eventos de dia inteiro (ex: bloqueios)

      const jaEnviado = await pool.query(
        'SELECT 1 FROM avaliacoes_enviadas WHERE event_id = $1',
        [ev.id]
      );
      if (jaEnviado.rows.length > 0) { pulados++; continue; }

      const priv = ev.extendedProperties?.private || {};
      const telefone = priv.telefone;
      if (!telefone) continue; // evento antigo, sem os dados estruturados

      const subRow = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
        [telefone]
      );
      if (subRow.rows.length === 0) continue; // cliente não tem inscrição de push

      const { nome } = parseNomeServico(ev.summary);

      const payload = JSON.stringify({
        title: 'Como foi seu atendimento? ⭐',
        body: `${nome ? nome + ', queremos' : 'Queremos'} saber sua opinião! Toque pra avaliar a Barbearia do Deeh.`,
        icon: '/icon-192.png',
        url: REVIEW_URL,
      });

      try {
        await webpush.sendNotification(subRow.rows[0].subscription, payload);
        await pool.query(
          'INSERT INTO avaliacoes_enviadas (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
          [ev.id]
        );
        enviados++;
      } catch (pushErr) {
        erros.push({ telefone, erro: pushErr.message });
      }
    }

    return res.status(200).json({
      success: true,
      verificados: eventos.length,
      enviados,
      pulados,
      erros,
    });
  } catch (err) {
    console.error('Erro ao enviar avaliações:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
