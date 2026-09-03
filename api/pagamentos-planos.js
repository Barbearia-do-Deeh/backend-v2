const pool = require('../lib/db');
const { VALOR_PLANO } = require('../lib/financas');
function addDias(data, dias) {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const client = await pool.connect();
  try {
    if (req.method === 'POST') {
      const { cliente_id, plano, forma_pagamento, data_pagamento } = req.body;
      if (!cliente_id || !plano) {
        return res.status(400).json({ error: 'cliente_id e plano são obrigatórios' });
      }
      const valor = VALOR_PLANO[plano];
      if (!valor) {
        return res.status(400).json({ error: `Plano desconhecido: ${plano}` });
      }
      const dataRef = data_pagamento || new Date().toISOString().slice(0, 10);
      const fim = addDias(dataRef, 30);
      const formaPagamentoFinal = forma_pagamento || 'pix';

      // Transação: o pagamento e o lançamento no razão financeiro nascem juntos.
      // Se o lançamento falhasse fora de uma transação, o pagamento ficaria
      // gravado em pagamentos_planos mas invisível no financeiro — exatamente
      // o tipo de inconsistência que o razão único existe pra evitar.
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO pagamentos_planos (cliente_id, plano, valor, forma_pagamento, data_pagamento, ciclo_inicio, ciclo_fim)
         VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
        [cliente_id, plano, valor, formaPagamentoFinal, dataRef, fim]
      );
      const pagamentoId = result.rows[0].id;
      await client.query(
        `INSERT INTO lancamentos_financeiros
           (tipo, status, valor, valor_referencia, metodo_pagamento, data_competencia,
            data_caixa, cliente_id, plano, origem_tipo, origem_id)
         VALUES ('receita_plano', 'confirmado', $1, $1, $2, $3, $3, $4, $5, 'pagamento_plano', $6)
         ON CONFLICT (origem_tipo, origem_id, tipo) DO UPDATE SET
           valor = EXCLUDED.valor,
           valor_referencia = EXCLUDED.valor_referencia,
           metodo_pagamento = EXCLUDED.metodo_pagamento,
           data_competencia = EXCLUDED.data_competencia,
           data_caixa = EXCLUDED.data_caixa`,
        [valor, formaPagamentoFinal, dataRef, cliente_id, plano, String(pagamentoId)]
      );
      await client.query('COMMIT');

      return res.status(200).json({ success: true, id: pagamentoId, valor, data_pagamento: dataRef, ciclo_fim: fim });
    }
    if (req.method === 'GET') {
      const { cliente_id } = req.query;
      if (cliente_id) {
        const result = await client.query(
          `SELECT * FROM pagamentos_planos WHERE cliente_id = $1 ORDER BY data_pagamento DESC`,
          [cliente_id]
        );
        return res.status(200).json({ success: true, pagamentos: result.rows });
      }
      const result = await client.query(`SELECT * FROM pagamentos_planos ORDER BY data_pagamento DESC LIMIT 100`);
      return res.status(200).json({ success: true, pagamentos: result.rows });
    }
    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erro em /api/pagamentos-planos:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
