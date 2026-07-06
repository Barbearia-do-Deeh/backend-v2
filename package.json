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
    const { nome, telefone, servico, data, horario, duracao, preco } = req.body;

    if (!nome || !telefone || !servico || !data || !horario) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar'],
    });

    const calendar = google.calendar({ version: 'v3', auth });

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

    const event = {
      summary: `✂️ ${servico} — ${nome}`,
      description: `📱 WhatsApp: ${telefone}\n💈 Serviço: ${servico}\n💰 Valor: ${preco}\n⏱ Duração: ${duracao || '60 min'}`,
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
    console.error('Erro ao criar evento:', err.message);
    return res.status(500).json({ error: 'Erro ao criar evento na agenda', details: err.message });
  }
};
