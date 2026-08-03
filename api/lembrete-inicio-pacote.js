// api/lembrete-inicio-pacote.js
// GET /api/lembrete-inicio-pacote?secret=SEU_CRON_SECRET
// Roda 1x por dia. Verifica clientes cujo data_inicio_ciclo é hoje
// e dispara push lembrando do início do pacote, com dica da chave Pix.

const webpush = require('web-push');
const pool = require('../lib/db');

const CRON_SECRET = process.env.CRON_SECRET;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contato@barbeariadodeeh.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

module.exports = async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).json({ success: false, error: 'Não autorizado' });
  }

  try {
    const clientesResult = await pool.query(
      `SELECT id, nome, telefone
       FROM clientes
       WHERE data_inicio_ciclo = CURRENT_DATE`
    );

    let enviados = 0;
    let pulados = 0;
    const erros = [];

    for (const cliente of clientesResult.rows) {
      const jaEnviado = await pool.query(
        'SELECT 1 FROM lembretes_pacote_enviados WHERE cliente_id = $1 AND data_referencia = CURRENT_DATE',
        [cliente.id]
      );
      if (jaEnviado.rows.length > 0) { pulados++; continue; }

      const subRow = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
        [cliente.telefone]
      );
      if (subRow.rows.length === 0) { pulados++; continue; }

      const payload = JSON.stringify({
        title: 'Barbearia do Deeh',
        body: `${cliente.nome}, seu pacote começa hoje! Se quiser adiantar o pagamento, é só copiar a chave Pix na aba Perfil do app.`,
        icon: '/icon-192.png',
      });

      try {
        await webpush.sendNotification(subRow.rows[0].subscription, payload);
        await pool.query(
          'INSERT INTO lembretes_pacote_enviados (cliente_id, data_referencia) VALUES ($1, CURRENT_DATE) ON CONFLICT DO NOTHING',
          [cliente.id]
        );
        enviados++;
      } catch (pushErr) {
        erros.push({ telefone: cliente.telefone, erro: pushErr.message });
      }
    }

    return res.status(200).json({
      success: true,
      verificados: clientesResult.rows.length,
      enviados,
      pulados,
      erros,
    });
  } catch (err) {
    console.error('Erro ao enviar lembretes de pacote:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
