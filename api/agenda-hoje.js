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
