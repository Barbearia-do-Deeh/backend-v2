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
      const { cliente_id, plano, forma_pagamento } = req.body;
      if (!cliente_id || !plano) {
        return res.status(400).json({ error: 'cliente_id e plano são obrigatórios' });
      }
      const valor = VALOR_PLANO[plano];
      if (!valor) {
        return res.status(400).json({ error: `Plano desconhecido: ${plano}` });
      }

      const hoje = new Date().toISOString().slice(0, 10);
      const fim = addDias(hoje, 30);

      const result = await client.query(
        `INSERT INTO pagamentos_planos (cliente_id, plano, valor, forma_pagamento, data_pagamento, ciclo_inicio, ciclo_fim)
         VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
        [cliente_id, plano, valor, forma_pagamento || 'pix', hoje, fim]
      );

      return res.status(200).json({ success: true, id: result.rows[0].id, valor });
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
    console.error('Erro em /api/pagamentos-planos:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
