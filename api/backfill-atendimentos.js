// api/backfill-atendimentos.js
// USO ÚNICO: recupera pro financeiro os agendamentos que já foram marcados
// "Compareceu" ANTES do agenda-hoje.js novo existir (o código antigo nunca
// gravava nada em `atendimentos` — só o Calendar). Depois de rodar uma vez
// e conferir que o financeiro bateu, pode apagar este arquivo.
//
// GET /api/backfill-atendimentos?secret=SEGREDO&mes=8&ano=2026
// mes/ano são opcionais — default é o mês atual.
//
// Idempotente: usa a mesma coluna UNIQUE (event_id) que marcarPresenca usa,
// então rodar de novo (ou rodar em cima de meses já processados) não duplica
// nada — só atualiza.
const { getCalendarClient, sincronizarAtendimento, CALENDAR_ID } = require('./agenda-hoje');

// Troque por um segredo seu antes de publicar — evita qualquer um na internet
// rodar isso só sabendo a URL. Pode ser removido junto com o arquivo depois.
const BACKFILL_SECRET = 'deeh-backfill-2026';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });

  if (req.query.secret !== BACKFILL_SECRET) {
    return res.status(403).json({ error: 'Segredo inválido' });
  }

  const hoje = new Date();
  const mes = parseInt(req.query.mes, 10) || (hoje.getMonth() + 1);
  const ano = parseInt(req.query.ano, 10) || hoje.getFullYear();

  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimDate = new Date(Date.UTC(ano, mes, 0)); // último dia do mês
  const fim = fimDate.toISOString().slice(0, 10);

  try {
    const calendar = getCalendarClient();
    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${inicio}T00:00:00-03:00`,
      timeMax: `${fim}T23:59:59-03:00`,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    const compareceram = eventos.filter(
      (ev) => (ev.extendedProperties?.private?.status) === 'compareceu'
    );

    let gravados = 0;
    let erros = [];

    for (const evento of compareceram) {
      try {
        await sincronizarAtendimento(evento, 'compareceu', null);
        gravados++;
      } catch (err) {
        erros.push({ eventId: evento.id, erro: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      periodo: { mes, ano, inicio, fim },
      total_eventos_no_periodo: eventos.length,
      marcados_compareceu: compareceram.length,
      gravados_com_sucesso: gravados,
      erros,
    });
  } catch (err) {
    console.error('Erro em /api/backfill-atendimentos:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  }
};
