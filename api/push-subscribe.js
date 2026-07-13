// api/push-subscribe.js
// POST /api/push-subscribe
// Body: { telefone: "5519999999999", subscription: {...objeto gerado pelo navegador...} }
// Salva (ou atualiza) a inscrição de push notification vinculada ao telefone do cliente.

const pool = require('../lib/db');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { telefone, subscription } = req.body;

    if (!telefone || !subscription) {
      return res.status(400).json({ success: false, error: 'telefone e subscription são obrigatórios' });
    }

    const telefoneLimpo = telefone.replace(/\D/g, '');

    await pool.query(
      `INSERT INTO push_subscriptions (telefone, subscription, atualizado_em)
       VALUES ($1, $2, NOW())
       ON CONFLICT (telefone)
       DO UPDATE SET subscription = $2, atualizado_em = NOW()`,
      [telefoneLimpo, JSON.stringify(subscription)]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Erro ao salvar inscrição de push:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
