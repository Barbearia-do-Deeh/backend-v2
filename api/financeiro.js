const pool = require('../lib/db');
const { calcularResumoPeriodo, calcularRetencao, periodoParaDatas } = require('../lib/financas');

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
// Antes lia o preço direto de eventos do Google Calendar (extendedProperties.private.preco,
// texto tipo "R$95,50" parseado por regex) — o que fazia a comissão de cliente de
// pacote dar errado: o evento sempre guarda o preço de TABELA do serviço, mesmo
// quando o cliente não pagou nada ali (já pagou na mensalidade). Agora lê de
// `lancamentos_financeiros.valor_referencia`, gravado por api/agenda-hoje.js só
// quando o atendimento é marcado "Compareceu" — falta já sai automaticamente
// (nunca chega a virar lançamento), sem precisar filtrar status aqui.
async function calcularFechamentoBarbeiros(client, { inicio, fim }) {
  const barbeirosResult = await client.query('SELECT * FROM barbeiros ORDER BY nome');
  const barbeiros = barbeirosResult.rows;

  const receitaServicosResult = await client.query(
    `SELECT barbeiro_id, COALESCE(SUM(valor_referencia), 0) AS total
     FROM lancamentos_financeiros
     WHERE tipo = 'receita_servico' AND status = 'confirmado' AND barbeiro_id IS NOT NULL
       AND data_competencia BETWEEN $1 AND $2
     GROUP BY barbeiro_id`,
    [inicio, fim]
  );
  const receitaServicosPorBarbeiro = {};
  for (const row of receitaServicosResult.rows) {
    receitaServicosPorBarbeiro[row.barbeiro_id] = Number(row.total);
  }

  // Receita de produtos por barbeiro (comandas do período) — já era exato, mantido igual.
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
    const receitaServicos = receitaServicosPorBarbeiro[b.id] || 0;
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
