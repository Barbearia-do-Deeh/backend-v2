const { google } = require('googleapis');
const webpush = require('web-push');
const pool = require('../lib/db');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || 'davidlucas261210@gmail.com';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@barbeariadodeeh.com';
const ADMIN_TELEFONE = '5519993900880'; // mesmo identificador usado no admin.html pra se inscrever

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function addDias(data, dias) {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ---- GET ?tipo=meus-agendamentos&telefone=... ----
// Lista os próximos 30 dias de agendamentos daquele telefone, usando
// extendedProperties.private.telefone (gravado na criação do evento) pra filtrar
// com precisão — não depende de parsear texto da description.
async function listarMeusAgendamentos(req, res) {
  const { telefone } = req.query;
  if (!telefone) {
    return res.status(400).json({ error: 'telefone é obrigatório' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();
  const now = new Date();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const result = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    privateExtendedProperty: [`telefone=${telefoneLimpo}`],
    singleEvents: true,
    orderBy: 'startTime',
  });

  const agendamentos = (result.data.items || []).map(ev => {
    const startStr = ev.start?.dateTime || ev.start?.date || '';
    const [dataPart, horaPart] = startStr.split('T');
    const [ano, mes, dia] = (dataPart || '').split('-');
    const horario = horaPart ? horaPart.slice(0, 5) : null;
    const priv = ev.extendedProperties?.private || {};
    return {
      eventId: ev.id,
      servico: priv.servico || ev.summary || '',
      data: dia && mes && ano ? `${dia}/${mes}/${ano}` : null,
      horario,
      preco: priv.preco || null,
    };
  });

  return res.status(200).json({ success: true, agendamentos });
}

// ---- POST ?tipo=cancelar { eventId, telefone } ----
// Confirma que o telefone bate com o dono do evento antes de apagar do Calendar.
async function cancelarAgendamento(req, res) {
  const { eventId, telefone } = req.body;
  if (!eventId || !telefone) {
    return res.status(400).json({ error: 'eventId e telefone são obrigatórios' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();

  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const telefoneDoEvento = evento.extendedProperties?.private?.telefone;
  if (telefoneDoEvento !== telefoneLimpo) {
    return res.status(403).json({ error: 'Este agendamento não pertence a esse telefone' });
  }

  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });
  return res.status(200).json({ success: true });
}

// ---- POST (padrão, sem tipo) — criar agendamento ----
async function criarAgendamento(req, res) {
  const { nome, telefone, servico, data, horario, duracao, preco, produtos } = req.body;
  if (!nome || !telefone || !servico || !data || !horario) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();

  // Montar data/hora do evento
  // CORREÇÃO: usamos Date.UTC para "fixar" o horário informado (11:00, por exemplo)
  // independente do fuso horário em que o servidor da Vercel está rodando.
  // Sem isso, o servidor (que roda em UTC) interpretava 11:00 como UTC e o evento
  // acabava sendo criado 3 horas adiantado/atrasado no Google Calendar.
  const [dia, mes, ano] = data.split('/');
  const [hora, minuto] = horario.split(':');
  const startUTC = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto));
  const duracaoMin = duracao === '15 min' ? 15 : 60;
  const endUTC = new Date(startUTC.getTime() + duracaoMin * 60000);

  // Como startUTC/endUTC foram criados com Date.UTC usando os números exatos
  // que o cliente escolheu, o toISOString() devolve esses mesmos números com "Z".
  // Trocamos o "Z" por "-03:00" para declarar corretamente que esse horário
  // já está no fuso de São Paulo (sem depender do fuso do servidor).
  const toISO = (d) => d.toISOString().replace('Z', '-03:00').slice(0, 19) + '-03:00';

  // ---- Produtos: valida contra o catálogo e monta o resumo da comanda ----
  let itensProduto = [];
  let valorProdutos = 0;
  if (Array.isArray(produtos) && produtos.length > 0) {
    const ids = produtos.map(p => p.id);
    const result = await pool.query(
      `SELECT id, nome, preco FROM produtos WHERE id = ANY($1::int[]) AND ativo = true`,
      [ids]
    );
    const catalogo = new Map(result.rows.map(p => [p.id, p]));
    for (const p of produtos) {
      const info = catalogo.get(p.id);
      if (!info) continue;
      const quantidade = p.quantidade && p.quantidade > 0 ? p.quantidade : 1;
      valorProdutos += Number(info.preco) * quantidade;
      itensProduto.push({ id: info.id, nome: info.nome, preco: Number(info.preco), quantidade });
    }
  }

  const resumoProdutos = itensProduto.length
    ? `\n🛍 Produtos: ${itensProduto.map(i => `${i.nome} x${i.quantidade}`).join(', ')} (R$ ${valorProdutos.toFixed(2).replace('.', ',')} — pago na hora)`
    : '';

  const event = {
    summary: `✂️ ${servico} — ${nome}`,
    description: `📱 WhatsApp: ${telefone}\n💈 Serviço: ${servico}\n💰 Valor: ${preco}\n⏱ Duração: ${duracao || '60 min'}${resumoProdutos}`,
    location: 'Rua Seraphin Gilberto Candelo, 2063 – Jd. Morada do Sol',
    start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
    colorId: '5', // Banana (amarelo)
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
    // Dados estruturados pra buscar/filtrar depois (ex: "Meus agendamentos" do cliente)
    // sem depender de parsear texto da description.
    extendedProperties: {
      private: {
        telefone: telefoneLimpo,
        servico,
        preco: preco || '',
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event,
  });

  // ---- Notifica o Deeh na hora (não espera o Google Calendar sincronizar) ----
  // Best-effort: se não tiver inscrição push ainda ou der erro, não derruba o agendamento.
  try {
    const subRow = await pool.query(
      'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
      [ADMIN_TELEFONE]
    );
    if (subRow.rows.length > 0) {
      const horaFmt = horario;
      const pushPayload = JSON.stringify({
        title: 'Novo agendamento! ✂️',
        body: `${nome} marcou ${servico} pra ${data} às ${horaFmt}.`,
        icon: '/icon-192.png',
      });
      await webpush.sendNotification(subRow.rows[0].subscription, pushPayload);
    }
  } catch (err) {
    console.error('Erro ao enviar push de novo agendamento:', err.message);
  }

  // ---- Garante que o cliente exista na tabela clientes (pra aparecer no admin) ----
  // Best-effort: se der erro aqui, não derruba o agendamento (o evento já foi criado).
  // Não mexe em plano/saldo de quem já existe — só atualiza o nome.
  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const fim = addDias(hoje, 30);
    const clienteResult = await pool.query(
      `INSERT INTO clientes (nome, telefone, plano, subtipo_essencial, data_inicio_ciclo, data_fim_ciclo)
       VALUES ($1, $2, 'nenhum', NULL, $3, $4)
       ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`,
      [nome, telefoneLimpo, hoje, fim]
    );
    const clienteId = clienteResult.rows[0].id;
    await pool.query(
      `INSERT INTO saldo_ciclo (cliente_id, cortes_restantes, barbas_restantes, pezinhos_restantes, sobrancelha_restante)
       VALUES ($1, 0, 0, 0, false)
       ON CONFLICT (cliente_id) DO NOTHING`,
      [clienteId]
    );
  } catch (err) {
    console.error('Erro ao gravar cliente:', err.message);
  }

  // ---- Grava a comanda de produtos no Neon (best-effort: não derruba o agendamento) ----
  let comandaId = null;
  if (itensProduto.length > 0) {
    try {
      const comandaResult = await pool.query(
        `INSERT INTO comandas (telefone, data_hora, produtos, valor_total)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [telefoneLimpo, toISO(startUTC), JSON.stringify(itensProduto), valorProdutos]
      );
      comandaId = comandaResult.rows[0].id;
    } catch (err) {
      console.error('Erro ao salvar comanda de produtos:', err.message);
    }
  }

  return res.status(200).json({
    success: true,
    eventId: response.data.id,
    eventLink: response.data.htmlLink,
    comanda_id: comandaId,
    produtos: itensProduto,
    valor_produtos: valorProdutos,
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tipo } = req.query;

  try {
    if (req.method === 'GET') {
      if (tipo === 'meus-agendamentos') return await listarMeusAgendamentos(req, res);
      return res.status(400).json({ error: 'tipo inválido para GET' });
    }

    if (req.method === 'POST') {
      if (tipo === 'cancelar') return await cancelarAgendamento(req, res);
      return await criarAgendamento(req, res);
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('Erro em /api/agendar:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  }
};
