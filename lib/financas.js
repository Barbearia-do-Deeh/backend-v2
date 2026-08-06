const VALOR_PLANO = {
  essencial: 160,
  classico: 260,
  empresario: 340,
};

function periodoParaDatas(mes, ano) {
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimDate = new Date(Date.UTC(ano, mes, 0));
  const fim = fimDate.toISOString().slice(0, 10);
  return { inicio, fim };
}

async function calcularResumoFinanceiro(client, { mes, ano }) {
  const { inicio, fim } = periodoParaDatas(mes, ano);

  const atendimentosResult = await client.query(
    `SELECT forma_pagamento, valor_cobrado, servicos FROM atendimentos
     WHERE data_hora::date BETWEEN $1 AND $2`,
    [inicio, fim]
  );

  const pagamentosResult = await client.query(
    `SELECT valor, plano FROM pagamentos_planos
     WHERE data_pagamento BETWEEN $1 AND $2`,
    [inicio, fim]
  );

  const despesasResult = await client.query(
    `SELECT categoria, valor FROM despesas
     WHERE data BETWEEN $1 AND $2`,
    [inicio, fim]
  );

  // Traz plano + valor_pacote de cada cliente ativo, pra usar o valor
  // personalizado (quando definido) em vez do valor fixo do plano.
  const clientesAtivosResult = await client.query(
    `SELECT plano, valor_pacote FROM clientes WHERE plano != 'nenhum'`
  );

  let receitaServicosAvulsos = 0;
  let qtdAtendimentos = atendimentosResult.rows.length;
  let qtdAvulsos = 0;
  let qtdCobertosPacote = 0;
  for (const row of atendimentosResult.rows) {
    receitaServicosAvulsos += parseFloat(row.valor_cobrado) || 0;
    if (row.forma_pagamento === 'avulso' || row.forma_pagamento === 'misto') qtdAvulsos++;
    if (row.forma_pagamento === 'pacote' || row.forma_pagamento === 'misto') qtdCobertosPacote++;
  }

  let receitaPlanos = 0;
  const receitaPlanosPorTipo = { essencial: 0, classico: 0, empresario: 0 };
  for (const row of pagamentosResult.rows) {
    const valor = parseFloat(row.valor) || 0;
    receitaPlanos += valor;
    if (receitaPlanosPorTipo[row.plano] !== undefined) receitaPlanosPorTipo[row.plano] += valor;
  }

  let totalDespesas = 0;
  const despesasPorCategoria = {};
  for (const row of despesasResult.rows) {
    const valor = parseFloat(row.valor) || 0;
    totalDespesas += valor;
    despesasPorCategoria[row.categoria] = (despesasPorCategoria[row.categoria] || 0) + valor;
  }

  const clientesAtivosPorPlano = {};
  let mrrEstimado = 0;
  for (const row of clientesAtivosResult.rows) {
    clientesAtivosPorPlano[row.plano] = (clientesAtivosPorPlano[row.plano] || 0) + 1;
    const valorCliente = row.valor_pacote !== null && row.valor_pacote !== undefined
      ? parseFloat(row.valor_pacote)
      : (VALOR_PLANO[row.plano] || 0);
    mrrEstimado += valorCliente;
  }

  const receitaTotal = receitaServicosAvulsos + receitaPlanos;
  const lucroLiquido = receitaTotal - totalDespesas;
  const ticketMedio = qtdAtendimentos > 0 ? receitaTotal / qtdAtendimentos : 0;

  return {
    periodo: { mes, ano, inicio, fim },
    receita: {
      servicos_avulsos: Number(receitaServicosAvulsos.toFixed(2)),
      planos: Number(receitaPlanos.toFixed(2)),
      planos_por_tipo: receitaPlanosPorTipo,
      total: Number(receitaTotal.toFixed(2)),
    },
    despesas: {
      total: Number(totalDespesas.toFixed(2)),
      por_categoria: despesasPorCategoria,
    },
    lucro_liquido: Number(lucroLiquido.toFixed(2)),
    atendimentos: {
      quantidade: qtdAtendimentos,
      avulsos: qtdAvulsos,
      cobertos_pelo_pacote: qtdCobertosPacote,
      ticket_medio: Number(ticketMedio.toFixed(2)),
    },
    clientes_ativos_por_plano: clientesAtivosPorPlano,
    mrr_estimado: Number(mrrEstimado.toFixed(2)),
  };
}

module.exports = { calcularResumoFinanceiro, VALOR_PLANO, periodoParaDatas };
