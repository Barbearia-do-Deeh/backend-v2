const pool = require('../lib/db');
const { calcularResumoFinanceiro, calcularRetencao } = require('../lib/financas');
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

    const hoje = new Date();
    const mes = parseInt(req.query.mes, 10) || (hoje.getMonth() + 1);
    const ano = parseInt(req.query.ano, 10) || hoje.getFullYear();
    const resumo = await calcularResumoFinanceiro(client, { mes, ano });
    return res.status(200).json({ success: true, ...resumo });
  } catch (err) {
    console.error('Erro em /api/financeiro:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
