const pool = require('../lib/db');
const { saldoInicial } = require('../lib/pacotes');

function addDias(data, dias) {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function renovarCicloSeVencido(client, cliente) {
  const hoje = new Date().toISOString().slice(0, 10);
  if (cliente.data_fim_ciclo && hoje > cliente.data_fim_ciclo) {
    const novoInicio = hoje;
    const novoFim = addDias(hoje, 30);
    const saldo = saldoInicial(cliente.plano, cliente.subtipo_essencial);

    await client.query(
      `UPDATE clientes SET data_inicio_ciclo = $1, data_fim_ciclo = $2 WHERE id = $3`,
      [novoInicio, novoFim, cliente.id]
    );
    await client.query(
      `UPDATE saldo_ciclo SET cortes_restantes = $1, barbas_restantes = $2,
       pezinhos_restantes = $3, sobrancelha_restante = $4 WHERE cliente_id = $5`,
      [saldo.cortes_restantes, saldo.barbas_restantes, saldo.pezinhos_restantes, saldo.sobrancelha_restante, cliente.id]
    );
    cliente.data_inicio_ciclo = novoInicio;
    cliente.data_fim_ciclo = novoFim;
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    if (req.method === 'POST') {
      const { nome, telefone, plano, subtipo_essencial } = req.body;

      if (!nome || !telefone) {
        return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
      }

      const planoFinal = plano || 'nenhum';
      const hoje = new Date().toISOString().slice(0, 10);
      const fim = addDias(hoje, 30);
      const saldo = saldoInicial(planoFinal, subtipo_essencial);

      const clienteResult = await client.query(
        `INSERT INTO clientes (nome, telefone, plano, subtipo_essencial, data_inicio_ciclo, data_fim_ciclo)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telefone) DO UPDATE SET
           nome = EXCLUDED.nome, plano = EXCLUDED.plano,
           subtipo_essencial = EXCLUDED.subtipo_essencial,
           data_inicio_ciclo = EXCLUDED.data_inicio_ciclo,
           data_fim_ciclo = EXCLUDED.data_fim_ciclo
         RETURNING id`,
        [nome, telefone, planoFinal, subtipo_essencial || null, hoje, fim]
      );
      const clienteId = clienteResult.rows[0].id;

      await client.query(
        `INSERT INTO saldo_ciclo (cliente_id, cortes_restantes, barbas_restantes, pezinhos_restantes, sobrancelha_restante)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cliente_id) DO UPDATE SET
           cortes_restantes = EXCLUDED.cortes_restantes,
           barbas_restantes = EXCLUDED.barbas_restantes,
           pezinhos_restantes = EXCLUDED.pezinhos_restantes,
           sobrancelha_restante = EXCLUDED.sobrancelha_restante`,
        [clienteId, saldo.cortes_restantes, saldo.barbas_restantes, saldo.pezinhos_restantes, saldo.sobrancelha_restante]
      );

      return res.status(200).json({ success: true, cliente_id: clienteId });
    }

    if (req.method === 'GET') {
      const { telefone } = req.query;
      if (!telefone) {
        // sem telefone = lista todos (uso do painel admin)
        const result = await client.query(
          `SELECT c.*, s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
           FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id
           ORDER BY c.nome`
        );
        return res.status(200).json({ success: true, clientes: result.rows });
      }

      const result = await client.query(
        `SELECT c.*, s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
         FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id
         WHERE c.telefone = $1`,
        [telefone]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Cliente não encontrado' });
      }

      const cliente = result.rows[0];
      const renovou = await renovarCicloSeVencido(client, cliente);
      if (renovou) {
        const atualizado = await client.query(
          `SELECT c.*, s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
           FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id WHERE c.id = $1`,
          [cliente.id]
        );
        return res.status(200).json({ success: true, cliente: atualizado.rows[0], ciclo_renovado: true });
      }

      return res.status(200).json({ success: true, cliente });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('Erro em /api/clientes:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
