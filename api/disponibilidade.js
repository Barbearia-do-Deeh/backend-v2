// api/disponibilidade.js
// Endpoint: GET/POST /api/disponibilidade?data=dd/mm/aaaa&barbeiro_id=123 (barbeiro_id opcional)
// Retorna os períodos já ocupados no Google Calendar para o dia informado.
//
// Antes usava calendar.freebusy.query — trocado por calendar.events.list porque o
// freebusy não dá acesso a extendedProperties, e sem isso não dá pra filtrar por
// barbeiro. Com barbeiro_id informado, um evento só conta como ocupado se:
//   (a) foi marcado pra esse barbeiro (extendedProperties.private.barbeiro_id bate), OU
//   (b) não tem barbeiro_id nenhum (bloqueio geral tipo almoço, ou evento antigo de
//       antes do multi-barbeiro — trata como "bloqueia todo mundo" por segurança)
// Eventos de outro barbeiro específico não contam como ocupado pra esse barbeiro.
// Sem barbeiro_id informado (uso normal quando só tem 1 barbeiro na barbearia),
// todo evento do dia conta como ocupado, sem distinção — igual ao comportamento antigo.
const { google } = require('googleapis');
const { CALENDAR_ID_PADRAO } = require('../lib/config-negocio');
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  try {
    const source = req.method === 'GET' ? req.query : req.body;
    const data = source.data;
    const barbeiroId = source.barbeiro_id ? String(source.barbeiro_id) : null;

    if (!data) {
      return res.status(400).json({ error: 'Parâmetro "data" é obrigatório (dd/mm/aaaa)' });
    }
    const [dia, mes, ano] = data.split('/');
    const dataISO = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
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

    const eventos = response.data.items || [];

    const ocupados = eventos
      .filter((ev) => ev.start?.dateTime && ev.end?.dateTime) // ignora eventos de dia inteiro
      .filter((ev) => {
        if (!barbeiroId) return true; // sem filtro de barbeiro, todo evento bloqueia
        const barbeiroDoEvento = ev.extendedProperties?.private?.barbeiro_id;
        return !barbeiroDoEvento || barbeiroDoEvento === barbeiroId;
      })
      .map((ev) => ({
        inicio: new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Sao_Paulo',
        }),
        fim: new Date(ev.end.dateTime).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'America/Sao_Paulo',
        }),
      }));

    return res.status(200).json({ success: true, data, ocupados });
  } catch (error) {
    console.error('Erro ao consultar disponibilidade:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};
