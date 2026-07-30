const { google } = require('googleapis');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || 'davidlucas261210@gmail.com';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { data, horaInicio, horaFim, motivo } = req.body;

    if (!data || !horaInicio || !horaFim) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    const [dia, mes, ano] = data.split('/');
    const [h1, m1] = horaInicio.split(':');
    const [h2, m2] = horaFim.split(':');
    const startUTC = new Date(Date.UTC(ano, mes - 1, dia, h1, m1));
    const endUTC = new Date(Date.UTC(ano, mes - 1, dia, h2, m2));

    const toISO = (d) => d.toISOString().replace('Z', '-03:00').slice(0, 19) + '-03:00';

    const event = {
      summary: `🚫 ${motivo || 'Bloqueado'}`,
      start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
      colorId: '8',
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    return res.status(200).json({ success: true, eventId: response.data.id });

  } catch (err) {
    console.error('Erro ao bloquear horário:', err.message);
    return res.status(500).json({ error: 'Erro ao bloquear horário', details: err.message });
  }
};
