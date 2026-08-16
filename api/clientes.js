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

// ---- Barbeiros ----
// Embutido neste arquivo (não em api/barbeiros.js) porque o backend-v2 já está no
// teto de 12 Serverless Functions do plano Hobby da Vercel. Acessado via
// ?recurso=barbeiros nas mesmas rotas GET/POST/PUT de sempre.
async function handleBarbeiros(req, res, client) {
  if (req.method === 'GET') {
    const result = await client.query('SELECT * FROM barbeiros ORDER BY nome');
    return res.status(200).json({ success: true, barbeiros: result.rows });
  }

  if (req.method === 'POST') {
    const { nome, regime, comissao_servico_pct, aluguel_fixo_valor, comissao_produtos_pct } = req.body;

    if (!nome || !regime) {
      return res.status(400).json({ error: 'nome e regime são obrigatórios' });
    }
    if (regime !== 'comissao' && regime !== 'aluguel') {
      return res.status(400).json({ error: 'regime deve ser "comissao" ou "aluguel"' });
    }

    const result = await client.query(
      `INSERT INTO barbeiros (nome, regime, comissao_servico_pct, aluguel_fixo_valor, comissao_produtos_pct)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        nome,
        regime,
        regime === 'comissao' ? (comissao_servico_pct === '' || comissao_servico_pct === undefined ? null : comissao_servico_pct) : null,
        regime === 'aluguel' ? (aluguel_fixo_valor === '' || aluguel_fixo_valor === undefined ? null : aluguel_fixo_valor) : null,
        comissao_produtos_pct === '' || comissao_produtos_pct === undefined ? 0 : comissao_produtos_pct,
      ]
    );

    return res.status(200).json({ success: true, barbeiro_id: result.rows[0].id });
  }

  if (req.method === 'PUT') {
    const { id, nome, regime, comissao_servico_pct, aluguel_fixo_valor, comissao_produtos_pct, ativo } = req.body;

    if (!id) {
      return res.status(400).json({ error: 'id é obrigatório' });
    }
    if (regime !== undefined && regime !== 'comissao' && regime !== 'aluguel') {
      return res.status(400).json({ error: 'regime deve ser "comissao" ou "aluguel"' });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (nome !== undefined) { fields.push(`nome = $${i++}`); values.push(nome); }
    if (regime !== undefined) { fields.push(`regime = $${i++}`); values.push(regime); }
    if (comissao_servico_pct !== undefined) {
      fields.push(`comissao_servico_pct = $${i++}`);
      values.push(comissao_servico_pct === '' ? null : comissao_servico_pct);
    }
    if (aluguel_fixo_valor !== undefined) {
      fields.push(`aluguel_fixo_valor = $${i++}`);
      values.push(aluguel_fixo_valor === '' ? null : aluguel_fixo_valor);
    }
    if (comissao_produtos_pct !== undefined) {
      fields.push(`comissao_produtos_pct = $${i++}`);
      values.push(comissao_produtos_pct === '' ? 0 : comissao_produtos_pct);
    }
    if (ativo !== undefined) { fields.push(`ativo = $${i++}`); values.push(ativo); }

    if (!fields.length) {
      return res.status(400).json({ error: 'Nada para atualizar' });
    }

    values.push(id);
    await client.query(`UPDATE barbeiros SET ${fields.join(', ')} WHERE id = $${i}`, values);

    const atualizado = await client.query('SELECT * FROM barbeiros WHERE id = $1', [id]);
    return res.status(200).json({ success: true, barbeiro: atualizado.rows[0] });
  }

  return res.status(405).json({ error: 'Método não permitido' });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const client = await pool.connect();
  try {
    if (req.query.recurso === 'barbeiros') {
      return await handleBarbeiros(req, res, client);
    }

    if (req.method === 'POST') {
      const { nome, telefone, plano, subtipo_essencial, valor_pacote, data_nascimento } = req.body;


      if (!nome || !telefone) {
        return res.status(400).json({ error: 'nome e telefone são obrigatórios' });
      }

      const planoFinal = plano || 'nenhum';
      const hoje = new Date().toISOString().slice(0, 10);
      const fim = addDias(hoje, 30);
      const saldo = saldoInicial(planoFinal, subtipo_essencial);
      const valorPacoteFinal = valor_pacote === '' || valor_pacote === undefined ? null : valor_pacote;
      const dataNascimentoFinal = data_nascimento === '' || data_nascimento === undefined ? null : data_nascimento;

      const clienteResult = await client.query(
        `INSERT INTO clientes (nome, telefone, plano, subtipo_essencial, valor_pacote, data_nascimento, data_inicio_ciclo, data_fim_ciclo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (telefone) DO UPDATE SET
           nome = EXCLUDED.nome,
           data_nascimento = COALESCE(EXCLUDED.data_nascimento, clientes.data_nascimento)
         RETURNING id`,
        [nome, telefone, planoFinal, subtipo_essencial || null, valorPacoteFinal, dataNascimentoFinal, hoje, fim]
      );
      const clienteId = clienteResult.rows[0].id;

      await client.query(
        `INSERT INTO saldo_ciclo (cliente_id, cortes_restantes, barbas_restantes, pezinhos_restantes, sobrancelha_restante)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (cliente_id) DO NOTHING`,
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

    if (req.method === 'PUT') {
      const { id, nome, telefone, plano, subtipo_essencial, valor_pacote, data_nascimento,
        cortes_restantes, barbas_restantes, pezinhos_restantes, sobrancelha_restante } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'id é obrigatório' });
      }

      await client.query('BEGIN');

      const clienteFields = [];
      const clienteValues = [];
      let i = 1;
      if (nome !== undefined) { clienteFields.push(`nome = $${i++}`); clienteValues.push(nome); }
      if (telefone !== undefined) { clienteFields.push(`telefone = $${i++}`); clienteValues.push(telefone); }
      if (plano !== undefined) { clienteFields.push(`plano = $${i++}`); clienteValues.push(plano); }
      if (subtipo_essencial !== undefined) { clienteFields.push(`subtipo_essencial = $${i++}`); clienteValues.push(subtipo_essencial); }
      if (valor_pacote !== undefined) {
        clienteFields.push(`valor_pacote = $${i++}`);
        clienteValues.push(valor_pacote === '' || valor_pacote === null ? null : valor_pacote);
      }
      if (data_nascimento !== undefined) {
        clienteFields.push(`data_nascimento = $${i++}`);
        clienteValues.push(data_nascimento === '' || data_nascimento === null ? null : data_nascimento);
      }

      if (clienteFields.length > 0) {
        clienteValues.push(id);
        await client.query(
          `UPDATE clientes SET ${clienteFields.join(', ')} WHERE id = $${i}`,
          clienteValues
        );
      }

      const saldoFields = [];
      const saldoValues = [];
      let j = 1;
      if (cortes_restantes !== undefined) { saldoFields.push(`cortes_restantes = $${j++}`); saldoValues.push(cortes_restantes); }
      if (barbas_restantes !== undefined) { saldoFields.push(`barbas_restantes = $${j++}`); saldoValues.push(barbas_restantes); }
      if (pezinhos_restantes !== undefined) { saldoFields.push(`pezinhos_restantes = $${j++}`); saldoValues.push(pezinhos_restantes); }
      if (sobrancelha_restante !== undefined) { saldoFields.push(`sobrancelha_restante = $${j++}`); saldoValues.push(sobrancelha_restante); }

      if (saldoFields.length > 0) {
        saldoValues.push(id);
        await client.query(
          `UPDATE saldo_ciclo SET ${saldoFields.join(', ')} WHERE cliente_id = $${j}`,
          saldoValues
        );
      }

      await client.query('COMMIT');

      const atualizado = await client.query(
        `SELECT c.*, s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
         FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id WHERE c.id = $1`,
        [id]
      );

      return res.status(200).json({ success: true, cliente: atualizado.rows[0] });
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('Erro em /api/clientes:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  } finally {
    client.release();
  }
};
