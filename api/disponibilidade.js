// api/disponibilidade.js
// Endpoint: GET/POST /api/disponibilidade?data=dd/mm/aaaa
// Retorna os períodos já ocupados no Google Calendar para o dia informado.
//
// IMPORTANTE: confirme os nomes das env vars abaixo contra as que já
// existem no agendar.js (GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY,
// GOOGLE_CALENDAR_ID) — usei os nomes mais prováveis com base no que
// já está configurado no projeto.

const { google } = require('googleapis');

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  try {
    const data = req.method === 'GET' ? req.query.data : req.body.data;
    if (!data) {
      return res.status(400).json({ error: 'Parâmetro "data" é obrigatório (dd/mm/aaaa)' });
    }

    const [dia, mes, ano] = data.split('/');
    const dataISO = `${ano}-${mes}-${dia}`;

    const auth = new google.auth.GoogleAuth({
      credentials: {
        client_email: process.env.GOOGLE_CLIENT_EMAIL,
        private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });

    const calendar = google.calendar({ version: 'v3', auth });
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'davidlucas261210@gmail.com';

    const timeMin = `${dataISO}T00:00:00-03:00`;
    const timeMax = `${dataISO}T23:59:59-03:00`;

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'America/Sao_Paulo',
        items: [{ id: calendarId }],
      },
    });

    const busy = response.data.calendars[calendarId].busy || [];

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
