// api/agenda-hoje.js
// Endpoint: GET /api/agenda-hoje?data=dd/mm/aaaa (data é opcional, default = hoje)
// USO: painel admin. Retorna os eventos reais do Google Calendar do dia,
// com nome do cliente, serviço e valor extraídos do evento (criado pelo agendar.js).
// Diferente do /api/disponibilidade (que só retorna horários ocupados, sem detalhes,
// pra não vazar dado de cliente no fluxo público de agendamento).

const { google } = require('googleapis');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || 'davidlucas261210@gmail.com';

function parseDescricao(desc) {
  const result = { telefone: null, valor: 0 };
  if (!desc) return result;
  const tel = desc.match(/WhatsApp:\s*(.+)/);
  const valor = desc.match(/Valor:\s*R?\$?\s*([\d.,]+)/);
  if (tel) result.telefone = tel[1].trim();// api/agenda-hoje.js
// GET /api/agenda-hoje?data=dd/mm/aaaa (data é opcional, default = hoje)
// USO: painel admin. Retorna os eventos reais do Google Calendar do dia,
// com nome do cliente, serviço e valor extraídos do evento (criado pelo agendar.js).
// Diferente do /api/disponibilidade (que só retorna horários ocupados, sem detalhes,
// pra não vazar dado de cliente no fluxo público de agendamento).
//
// POST /api/agenda-hoje?tipo=marcar-presenca { eventId, status }
// status: 'compareceu' | 'faltou' | 'pendente'. Grava no próprio evento do Calendar
// (extendedProperties.private.status), sem precisar de tabela nova. Usado pela Agenda
// de hoje do admin pra saber quem veio e quem faltou — e, por consequência, excluir
// faltas do fechamento por barbeiro (ver api/financeiro.js).
const { google } = require('googleapis');
const { CALENDAR_ID_PADRAO } = require('../lib/config-negocio');
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    // precisa de escopo de escrita (não só readonly) por causa do marcar-presenca
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

function parseDescricao(desc) {
  const result = { telefone: null, valor: 0 };
  if (!desc) return result;
  const tel = desc.match(/WhatsApp:\s*(.+)/);
  const valor = desc.match(/Valor:\s*R?\$?\s*([\d.,]+)/);
  if (tel) result.telefone = tel[1].trim();
  if (valor) result.valor = parseFloat(valor[1].replace(',', '.')) || 0;
  return result;
}
function parseNomeServico(summary) {
  // Formato gravado pelo agendar.js: "✂️ <servico> — <nome>"
  const partes = (summary || '').split(' — ');
  const nome = partes.length > 1 ? partes[1].trim() : '';
  const servico = partes.length > 0 ? partes[0].replace(/^[^\p{L}]+/u, '').trim() : (summary || '');
  return { nome, servico };
}

async function listarAgenda(req, res) {
  const dataParam = req.query.data;
  let dataISO;
  if (dataParam) {
    const [dia, mes, ano] = dataParam.split('/');
    dataISO = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  } else {
    dataISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // yyyy-mm-dd
  }
  const calendar = getCalendarClient();
  const timeMin = `${dataISO}T00:00:00-03:00`;
  const timeMax = `${dataISO}T23:59:59-03:00`;
  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const eventos = (response.data.items || [])
    .filter((ev) => ev.start && ev.start.dateTime) // ignora eventos de dia inteiro
    .map((ev) => {
      const { nome, servico } = parseNomeServico(ev.summary);
      const info = parseDescricao(ev.description);
      const priv = ev.extendedProperties?.private || {};
      const horaInicio = new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });
      const horaFim = new Date(ev.end.dateTime).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });
      return {
        id: ev.id,
        nome: nome || 'Cliente',
        servico: servico || ev.summary || '',
        horaInicio,
        horaFim,
        valor: info.valor,
        telefone: info.telefone,
        status: priv.status || 'pendente',
      };
    });
  // Faturamento estimado do dia continua contando tudo (é só uma estimativa em tempo
  // real) — quem quiser o número já sem falta usa o fechamento por barbeiro no Financeiro.
  const faturamentoEstimado = eventos.reduce((s, e) => s + (e.valor || 0), 0);
  return res.status(200).json({
    success: true,
    data: dataISO,
    eventos,
    total: eventos.length,
    faturamento_estimado: faturamentoEstimado,
  });
}

async function marcarPresenca(req, res) {
  const { eventId, status } = req.body || {};
  if (!eventId || !['compareceu', 'faltou', 'pendente'].includes(status)) {
    return res.status(400).json({ error: 'eventId e status (compareceu|faltou|pendente) são obrigatórios' });
  }

  const calendar = getCalendarClient();

  // Busca o evento primeiro pra não perder telefone/servico/preco/barbeiro_id já
  // gravados — o patch do Calendar substitui o objeto extendedProperties.private
  // inteiro, então precisa mandar de volta tudo que já tinha + o status novo.
  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const privateAtual = evento.extendedProperties?.private || {};

  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    resource: {
      extendedProperties: {
        private: { ...privateAtual, status },
      },
    },
  });

  return res.status(200).json({ success: true, eventId, status });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.query.tipo === 'marcar-presenca') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
      return await marcarPresenca(req, res);
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
    return await listarAgenda(req, res);
  } catch (err) {
    console.error('Erro em /api/agenda-hoje:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};

  if (valor) result.valor = parseFloat(valor[1].replace(',', '.')) || 0;
  return result;
}

function parseNomeServico(summary) {
  // Formato gravado pelo agendar.js: "✂️ <servico> — <nome>"
  const partes = (summary || '').split(' — ');
  const nome = partes.length > 1 ? partes[1].trim() : '';
  const servico = partes.length > 0 ? partes[0].replace(/^[^\p{L}]+/u, '').trim() : (summary || '');
  return { nome, servico };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const dataParam = req.query.data;
    let dataISO;
    if (dataParam) {
      const [dia, mes, ano] = dataParam.split('/');
      dataISO = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    } else {
      dataISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // yyyy-mm-dd
    }

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });

    const timeMin = `${dataISO}T00:00:00-03:00`;
    const timeMax = `${dataISO}T23:59:59-03:00`;

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = (response.data.items || [])
      .filter((ev) => ev.start && ev.start.dateTime) // ignora eventos de dia inteiro
      .map((ev) => {
        const { nome, servico } = parseNomeServico(ev.summary);
        const info = parseDescricao(ev.description);
        const horaInicio = new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        });
        const horaFim = new Date(ev.end.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
        });
        return {
          id: ev.id,
          nome: nome || 'Cliente',
          servico: servico || ev.summary || '',
          horaInicio,
          horaFim,
          valor: info.valor,
          telefone: info.telefone,
        };
      });

    const faturamentoEstimado = eventos.reduce((s, e) => s + (e.valor || 0), 0);

    return res.status(200).json({
      success: true,
      data: dataISO,
      eventos,
      total: eventos.length,
      faturamento_estimado: faturamentoEstimado,
    });
  } catch (err) {
    console.error('Erro ao buscar agenda do dia:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
