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
  // Proteção simples: só executa quem souber o secret
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Não autorizado' });
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
