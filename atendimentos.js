const pool = require('../lib/db');
const { PRECOS, saldoInicial, campoSaldo } = require('../lib/pacotes');

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
    if (req.method === 'GET') {
      const result = await client.query(
        `SELECT a.*, c.nome, c.telefone FROM atendimentos a
         JOIN clientes c ON c.id = a.cliente_id
         ORDER BY a.data_hora DESC LIMIT 100`
      );
      return res.status(200).json({ success: true, atendimentos: result.rows });
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Método não permitido' });
    }

    const { telefone, servicos } = req.body;
    if (!telefone || !Array.isArray(servicos) || servicos.length === 0) {
      return res.status(400).json({ error: 'telefone e servicos (array) são obrigatórios' });
    }

    await client.query('BEGIN');

    const clienteResult = await client.query(
      `SELECT c.*, s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
       FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id
       WHERE c.telefone = $1 FOR UPDATE`,
      [telefone]
    );

    if (clienteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cliente não encontrado. Cadastre primeiro em /api/clientes' });
    }

    let cliente = clienteResult.rows[0];

    // Renova ciclo se vencido
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
      cliente = { ...cliente, ...saldo, data_inicio_ciclo: novoInicio, data_fim_ciclo: novoFim };
    }

    const cobertos = [];
    const avulsos = [];
    const updates = {}; // campo -> novo valor

    for (const servico of servicos) {
      const campo = campoSaldo(servico);
      if (!campo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Serviço desconhecido: ${servico}` });
      }

      if (campo === 'sobrancelha_restante') {
        const disponivel = updates[campo] !== undefined ? updates[campo] : cliente.sobrancelha_restante;
        if (disponivel) {
          cobertos.push(servico);
          updates[campo] = false;
        } else {
          avulsos.push(servico);
        }
      } else {
        const atual = updates[campo] !== undefined ? updates[campo] : cliente[campo];
        if (atual > 0) {
          cobertos.push(servico);
          updates[campo] = atual - 1;
        } else {
          avulsos.push(servico);
        }
      }
    }

    // Calcula valor cobrado dos serviços avulsos
    let valorCobrado = 0;
    const avulsosSet = new Set(avulsos);
    if (avulsosSet.has('corte') && avulsosSet.has('barba')) {
      valorCobrado += PRECOS.corte_barba;
      avulsosSet.delete('corte');
      avulsosSet.delete('barba');
    }
    for (const s of avulsosSet) {
      valorCobrado += PRECOS[s] || 0;
    }

    const formaPagamento = avulsos.length === 0 ? 'pacote' : (cobertos.length === 0 ? 'avulso' : 'misto');

    // Aplica updates de saldo
    const setClauses = Object.keys(updates).map((campo, i) => `${campo} = $${i + 2}`);
    if (setClauses.length > 0) {
      const values = [cliente.id, ...Object.values(updates)];
      await client.query(
        `UPDATE saldo_ciclo SET ${setClauses.join(', ')} WHERE cliente_id = $1`,
        values
      );
    }

    const atendimentoResult = await client.query(
      `INSERT INTO atendimentos (cliente_id, servicos, forma_pagamento, valor_cobrado)
       VALUES ($1, $2, $3, $4) RETURNING id, data_hora`,
      [cliente.id, JSON.stringify(servicos), formaPagamento, valorCobrado]
    );

    await client.query('COMMIT');

    return res.status(200).json({
      success: true,
      atendimento_id: atendimentoResult.rows[0].id,
      cliente: cliente.nome,
      servicos_cobertos_pelo_pacote: cobertos,
      servicos_avulsos: avulsos,
      forma_pagamento: formaPagamento,
      valor_cobrado: valorCobrado,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Erro em /api/atendimentos:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
