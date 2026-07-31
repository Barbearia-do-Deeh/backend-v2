const pool = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    if (req.method === 'POST') {
      const { descricao, categoria, valor, data, recorrente } = req.body;
      if (!descricao || !categoria || !valor) {
        return res.status(400).json({ error: 'descricao, categoria e valor são obrigatórios' });
      }
      const result = await client.query(
        `INSERT INTO despesas (descricao, categoria, valor, data, recorrente)
         VALUES ($1, $2, $3, COALESCE($4, CURRENT_DATE), $5) RETURNING id`,
        [descricao, categoria, valor, data || null, !!recorrente]
      );
      return res.status(200).json({ success: true, id: result.rows[0].id });
    }

    if (req.method === 'GET') {
      const { mes, ano } = req.query;
      if (mes && ano) {
        const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
        const fimDate = new Date(Date.UTC(ano, mes, 0));
        const fim = fimDate.toISOString().slice(0, 10);
        const result = await client.query(
          `SELECT * FROM despesas WHERE data BETWEEN $1 AND $2 ORDER BY data DESC`,
          [inicio, fim]
        );
        return res.status(200).json({ success: true, despesas: result.rows });
      }
      const result = await client.query(`SELECT * FROM despesas ORDER BY data DESC LIMIT 100`);
      return res.status(200).json({ success: true, despesas: result.rows });
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id é obrigatório' });
      await client.query(`DELETE FROM despesas WHERE id = $1`, [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('Erro em /api/despesas:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
