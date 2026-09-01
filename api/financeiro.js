const { google } = require('googleapis');
const pool = require('../lib/db');
const { calcularResumoPeriodo, calcularRetencao, periodoParaDatas } = require('../lib/financas');
const { CALENDAR_ID_PADRAO } = require('../lib/config-negocio');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;

// Extrai um número de um texto de preço tipo "R$95" ou "R$95,50" (formato salvo em
// extendedProperties.private.preco pelo agendar.js). Falha segura: retorna 0 se não achar nada.
function parsePreco(precoStr) {
  if (!precoStr) return 0;
  const limpo = String(precoStr).replace(/[^\d,.-]/g, '').replace(',', '.');
  const num = parseFloat(limpo);
  return Number.isFinite(num) ? num : 0;
}

// Resolve o período da consulta a partir da query string:
//   ?inicio=YYYY-MM-DD&fim=YYYY-MM-DD  -> usa direto (semana, quinzena, personalizado, etc.)
//   ?mes=8&ano=2026                     -> mês/ano específico (compatibilidade)
//   nada                                -> mês atual (default de sempre)
function resolverPeriodo(query) {
  if (query.inicio && query.fim) {
    return { inicio: query.inicio, fim: query.fim };
  }
  const hoje = new Date();
  const mes = parseInt(query.mes, 10) || (hoje.getMonth() + 1);
  const ano = parseInt(query.ano, 10) || hoje.getFullYear();
  return periodoParaDatas(mes, ano);
}

// ---- Fechamento por barbeiro ----
// GET ?tipo=barbeiros&inicio=&fim= (ou &mes=&ano= por compatibilidade)
// Pra cada barbeiro cadastrado, calcula quanto ele tem a receber no período:
//   regime 'aluguel'  -> valor fixo cadastrado (não depende de volume)
//   regime 'comissao' -> % sobre a soma dos preços dos agendamentos dele no Google
//                         Calendar naquele período (extendedProperties.private.barbeiro_id)
// Nos dois regimes, soma também a comissão sobre produtos vendidos (tabela `comandas`,
// filtrada por barbeiro_id).
async function calcularFechamentoBarbeiros(client, { inicio, fim }) {
  const barbeirosResult = await client.query('SELECT * FROM barbeiros ORDER BY nome');
  const barbeiros = barbeirosResult.rows;

  // Receita de serviços por barbeiro: uma única busca no Calendar cobrindo o período
  // inteiro, depois soma em memória por barbeiro_id (evita 1 chamada de API por barbeiro).
  const receitaServicosPorBarbeiro = {};
  try {
    const auth = new google.auth.JWT({
      email: CLIENT_EMAIL,
      key: PRIVATE_KEY,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    });
    const calendar = google.calendar({ version: 'v3', auth });
    const timeMin = `${inicio}T00:00:00-03:00`;
    const timeMax = `${fim}T23:59:59-03:00`;

    const response = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    for (const ev of eventos) {
      const priv = ev.extendedProperties?.private || {};
      const barbeiroId = priv.barbeiro_id;
      if (!barbeiroId) continue; // sem barbeiro marcado (bloqueio geral, ou evento antigo)
      if (priv.status === 'faltou') continue; // cliente não veio — não conta como receita/comissão
      const valor = parsePreco(priv.preco);
      receitaServicosPorBarbeiro[barbeiroId] = (receitaServicosPorBarbeiro[barbeiroId] || 0) + valor;
    }
  } catch (err) {
    console.error('Erro ao buscar eventos do Calendar pro fechamento por barbeiro:', err.message);
    // segue com receitaServicosPorBarbeiro vazio — melhor mostrar comissão zerada
    // do que derrubar a tela inteira do Financeiro
  }

  // Receita de produtos por barbeiro (comandas do período)
  const comandasResult = await client.query(
    `SELECT barbeiro_id, COALESCE(SUM(valor_total), 0) AS total
     FROM comandas
     WHERE barbeiro_id IS NOT NULL
       AND data_hora::date BETWEEN $1 AND $2
     GROUP BY barbeiro_id`,
    [inicio, fim]
  );
  const receitaProdutosPorBarbeiro = {};
  for (const row of comandasResult.rows) {
    receitaProdutosPorBarbeiro[row.barbeiro_id] = Number(row.total);
  }

  return barbeiros.map((b) => {
    const receitaServicos = receitaServicosPorBarbeiro[String(b.id)] || 0;
    const receitaProdutos = receitaProdutosPorBarbeiro[b.id] || 0;

    const comissaoServico = b.regime === 'comissao'
      ? receitaServicos * ((Number(b.comissao_servico_pct) || 0) / 100)
      : 0;
    const comissaoProdutos = receitaProdutos * ((Number(b.comissao_produtos_pct) || 0) / 100);
    const aluguel = b.regime === 'aluguel' ? (Number(b.aluguel_fixo_valor) || 0) : 0;

    const totalAPagar = b.regime === 'aluguel'
      ? aluguel + comissaoProdutos
      : comissaoServico + comissaoProdutos;

    return {
      id: b.id,
      nome: b.nome,
      regime: b.regime,
      ativo: b.ativo,
      receita_servicos: Number(receitaServicos.toFixed(2)),
      receita_produtos: Number(receitaProdutos.toFixed(2)),
      aluguel_fixo: Number(aluguel.toFixed(2)),
      comissao_servico: Number(comissaoServico.toFixed(2)),
      comissao_produtos: Number(comissaoProdutos.toFixed(2)),
      total_a_pagar: Number(totalAPagar.toFixed(2)),
    };
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
  const client = await pool.connect();
  try {
    if (req.query.tipo === 'retencao') {
      const retencao = await calcularRetencao(client);
      return res.status(200).json({ success: true, retencao });
    }

    const { inicio, fim } = resolverPeriodo(req.query);

    if (req.query.tipo === 'barbeiros') {
      const barbeiros = await calcularFechamentoBarbeiros(client, { inicio, fim });
      return res.status(200).json({ success: true, periodo: { inicio, fim }, barbeiros });
    }

    const resumo = await calcularResumoPeriodo(client, { inicio, fim });
    return res.status(200).json({ success: true, ...resumo });
  } catch (err) {
    console.error('Erro em /api/financeiro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
