const { google } = require('googleapis');
const { CALENDAR_ID_PADRAO } = require('../lib/config-negocio');
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
  try {
    const { data, horaInicio, horaFim, motivo, barbeiro_id, repetirSemanas } = req.body;
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
    const count = parseInt(repetirSemanas, 10) || 0;
    const event = {
      // Sem barbeiro_id, o bloqueio vale pra barbearia toda (mesmo comportamento de
      // sempre). Com barbeiro_id, disponibilidade.js só trava a agenda desse barbeiro
      // específico — os outros continuam livres nesse horário.
      summary: `🚫 ${motivo || 'Bloqueado'}`,
      start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
      colorId: '8',
      // Bloqueio recorrente (ex: todo sábado à tarde fechado por padrão). Pra "abrir"
      // uma data específica depois, é só apagar aquela ocorrência direto no Google
      // Calendar ("apagar somente este evento") — não precisa mexer no app.
      ...(count > 1 ? { recurrence: [`RRULE:FREQ=WEEKLY;COUNT=${count}`] } : {}),
      ...(barbeiro_id ? { extendedProperties: { private: { barbeiro_id: String(barbeiro_id) } } } : {}),
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
