// api/disponibilidade.js
// Endpoint: GET/POST /api/disponibilidade?data=dd/mm/aaaa
// Retorna os períodos já ocupados no Google Calendar para o dia informado.
// Env vars e padrão de auth iguais aos do agendar.js (JWT + CALENDAR_ID).

const { google } = require('googleapis');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || 'davidlucas261210@gmail.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const data = req.method === 'GET' ? req.query.data : req.body.data;
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

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'America/Sao_Paulo',
        items: [{ id: CALENDAR_ID }],
      },
    });

    const busy = response.data.calendars[CALENDAR_ID].busy || [];

    const ocupados = busy.map((periodo) => ({
      inicio: new Date(periodo.start).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
      }),
      fim: new Date(periodo.end).toLocaleTimeString('pt-BR', {
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
