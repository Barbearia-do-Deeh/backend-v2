const { google } = require('googleapis');
const { ENDERECO, CALENDAR_ID_PADRAO } = require('../lib/config-negocio');

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
    const { nome, telefone, servico, dataInicio, horario, duracao, preco, repeticoes } = req.body;

    if (!nome || !telefone || !servico || !dataInicio || !horario) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

    const [dia, mes, ano] = dataInicio.split('/');
    const [hora, minuto] = horario.split(':');
    const startUTC = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto));
    const duracaoMin = duracao === '15 min' ? 15 : 60;
    const endUTC = new Date(startUTC.getTime() + duracaoMin * 60000);

    const toISO = (d) => d.toISOString().replace('Z', '-03:00').slice(0, 19) + '-03:00';

    const count = parseInt(repeticoes, 10) || 12;

    const event = {
      summary: `✂️ ${servico} — ${nome} (fixo)`,
      description: `📱 WhatsApp: ${telefone}\n💈 Serviço: ${servico}\n💰 Valor: ${preco || 'incluso no pacote'}\n⏱ Duração: ${duracao || '60 min'}\n🔁 Horário fixo semanal`,
      location: ENDERECO,
      start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
      end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
      recurrence: [`RRULE:FREQ=WEEKLY;COUNT=${count}`],
      colorId: '5',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });

    return res.status(200).json({
      success: true,
      eventId: response.data.id,
      eventLink: response.data.htmlLink,
    });

  } catch (err) {
    console.error('Erro ao criar horário fixo:', err.message);
    return res.status(500).json({ error: 'Erro ao criar horário fixo', details: err.message });
  }
};
