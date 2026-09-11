const pool = require('../lib/db');
const { PRECOS, saldoInicial, campoSaldo } = require('../lib/pacotes');

function addDias(data, dias) {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tipo } = req.query;
  const client = await pool.connect();
  try {
    // ---- Produtos ----
    if (tipo === 'produtos') {

      // ---- Catálogo (admin): CRUD completo, incluindo preço de custo ----
      // Preço de custo NUNCA aparece na listagem pública (?tipo=produtos sem
      // recurso, usada pelo app do cliente) — só aqui, em ?recurso=catalogo,
      // que só o admin.html chama.
      if (req.query.recurso === 'catalogo') {
        if (req.method === 'GET') {
          const result = await client.query(
            `SELECT id, nome, descricao, preco, preco_custo, imagem_url, ativo
             FROM produtos ORDER BY nome`
          );
          return res.status(200).json({ success: true, produtos: result.rows });
        }

        if (req.method === 'POST') {
          const { nome, descricao, preco, preco_custo, imagem_url } = req.body;
          if (!nome || preco === undefined || preco === null || preco === '') {
            return res.status(400).json({ error: 'nome e preco são obrigatórios' });
          }
          const result = await client.query(
            `INSERT INTO produtos (nome, descricao, preco, preco_custo, imagem_url, ativo)
             VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
            [nome, descricao || null, preco, preco_custo || 0, imagem_url || null]
          );
          return res.status(200).json({ success: true, id: result.rows[0].id });
        }

        if (req.method === 'PUT') {
          const { id, nome, descricao, preco, preco_custo, imagem_url, ativo } = req.body;
          if (!id) return res.status(400).json({ error: 'id é obrigatório' });
          await client.query(
            `UPDATE produtos SET nome = $2, descricao = $3, preco = $4, preco_custo = $5,
             imagem_url = $6, ativo = $7 WHERE id = $1`,
            [id, nome, descricao || null, preco, preco_custo || 0, imagem_url || null, ativo !== false]
          );
          return res.status(200).json({ success: true });
        }

        if (req.method === 'DELETE') {
          // Desativa em vez de apagar — preserva o histórico de comandas antigas,
          // que já guardam nome/preço/custo congelados no momento da venda dentro
          // do próprio JSON da comanda (não dependem de o produto ainda existir).
          const { id } = req.body;
          if (!id) return res.status(400).json({ error: 'id é obrigatório' });
          await client.query(`UPDATE produtos SET ativo = false WHERE id = $1`, [id]);
          return res.status(200).json({ success: true });
        }

        return res.status(405).json({ error: 'Método não permitido' });
      }

      // ---- Venda avulsa de produto (balcão, sem agendamento associado) ----
      // Usada pelo admin (ficha do cliente) quando o cliente compra produto
      // sem estar vinculado a um horário marcado. Vira um "atendimento" sem
      // serviço (servicos=[], valor_cobrado=0), só pra ter UM lugar só de
      // onde o Resumo do Financeiro lê receita de produto (evita reabrir o
      // mesmo problema de duas fontes de verdade que motivou o redesenho do
      // Financeiro) — e gera o lançamento correspondente em
      // lancamentos_financeiros, igual a qualquer venda vinculada a agendamento.
      if (req.query.recurso === 'venda-avulsa') {
        if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

        const { cliente_id, produtos, barbeiro_id, metodo_pagamento } = req.body;
        if (!cliente_id || !Array.isArray(produtos) || produtos.length === 0) {
          return res.status(400).json({ error: 'cliente_id e produtos (array) são obrigatórios' });
        }

        const clienteResult = await client.query(`SELECT id, telefone FROM clientes WHERE id = $1`, [cliente_id]);
        if (clienteResult.rows.length === 0) {
          return res.status(404).json({ error: 'Cliente não encontrado' });
        }
        const telefoneCliente = clienteResult.rows[0].telefone;

        const ids = produtos.map(p => p.id);
        const catalogoResult = await client.query(
          `SELECT id, nome, preco, preco_custo FROM produtos WHERE id = ANY($1::int[]) AND ativo = true`,
          [ids]
        );
        const catalogo = new Map(catalogoResult.rows.map(p => [p.id, p]));

        let valorTotal = 0;
        let custoTotal = 0;
        const itens = [];
        for (const p of produtos) {
          const info = catalogo.get(p.id);
          if (!info) continue;
          const quantidade = p.quantidade && p.quantidade > 0 ? p.quantidade : 1;
          valorTotal += Number(info.preco) * quantidade;
          custoTotal += Number(info.preco_custo || 0) * quantidade;
          itens.push({
            id: info.id, nome: info.nome, preco: Number(info.preco),
            custo: Number(info.preco_custo || 0), quantidade,
          });
        }
        if (itens.length === 0) {
          return res.status(400).json({ error: 'Nenhum produto válido encontrado' });
        }

        const agoraISO = new Date().toISOString();
        const dataCompetencia = agoraISO.slice(0, 10);
        // Sintético (não vem de evento do Calendar) — só precisa ser único pra
        // satisfazer o UNIQUE de atendimentos.event_id e de lancamentos_financeiros.
        const eventIdSintetico = `avulso-${cliente_id}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        await client.query('BEGIN');
        try {
          const comandaResult = await client.query(
            `INSERT INTO comandas (telefone, data_hora, produtos, valor_total, custo_total, barbeiro_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [telefoneCliente, agoraISO, JSON.stringify(itens), valorTotal, custoTotal, barbeiro_id || null]
          );

          const atendimentoResult = await client.query(
            `INSERT INTO atendimentos
               (cliente_id, event_id, data_hora, servicos, forma_pagamento, valor_cobrado,
                valor_referencia, valor_produtos, produtos_consumidos, barbeiro_id, metodo_pagamento)
             VALUES ($1, $2, $3, '[]', 'avulso', 0, 0, $4, $5, $6, $7) RETURNING id`,
            [cliente_id, eventIdSintetico, agoraISO, valorTotal, JSON.stringify(itens), barbeiro_id || null, metodo_pagamento || null]
          );

          await client.query(`UPDATE comandas SET atendimento_id = $1 WHERE id = $2`,
            [atendimentoResult.rows[0].id, comandaResult.rows[0].id]);

          await client.query(
            `INSERT INTO lancamentos_financeiros
               (tipo, status, valor, valor_referencia, metodo_pagamento, data_competencia,
                data_caixa, cliente_id, barbeiro_id, origem_tipo, origem_id)
             VALUES ('receita_produto', 'confirmado', $1, $1, $2, $3, $3, $4, $5, 'atendimento', $6)
             ON CONFLICT (origem_tipo, origem_id, tipo) DO NOTHING`,
            [valorTotal, metodo_pagamento || null, dataCompetencia, cliente_id, barbeiro_id || null, eventIdSintetico]
          );

          await client.query('COMMIT');
          return res.status(200).json({ success: true, comanda_id: comandaResult.rows[0].id, valor_total: valorTotal });
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      }

      // ---- Listagem pública (app do cliente) e registro de comanda ----
      if (req.method === 'GET') {
        const result = await client.query(
          `SELECT id, nome, descricao, preco, imagem_url FROM produtos WHERE ativo = true ORDER BY nome`
        );
        return res.status(200).json({ success: true, produtos: result.rows });
      }

      if (req.method === 'POST') {
        const { telefone, data_hora, produtos, barbeiro_id } = req.body;
        if (!telefone || !data_hora || !Array.isArray(produtos) || produtos.length === 0) {
          return res.status(400).json({ error: 'telefone, data_hora e produtos (array) são obrigatórios' });
        }

        const ids = produtos.map(p => p.id);
        const result = await client.query(
          `SELECT id, nome, preco, preco_custo FROM produtos WHERE id = ANY($1::int[]) AND ativo = true`,
          [ids]
        );
        const catalogo = new Map(result.rows.map(p => [p.id, p]));

        let valorTotal = 0;
        let custoTotal = 0;
        const itens = [];
        for (const p of produtos) {
          const info = catalogo.get(p.id);
          if (!info) continue;
          const quantidade = p.quantidade && p.quantidade > 0 ? p.quantidade : 1;
          valorTotal += Number(info.preco) * quantidade;
          custoTotal += Number(info.preco_custo || 0) * quantidade;
          itens.push({
            id: info.id, nome: info.nome, preco: Number(info.preco),
            custo: Number(info.preco_custo || 0), quantidade,
          });
        }

        if (itens.length === 0) {
          return res.status(400).json({ error: 'Nenhum produto válido encontrado' });
        }

        const comandaResult = await client.query(
          `INSERT INTO comandas (telefone, data_hora, produtos, valor_total, custo_total, barbeiro_id)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [telefone, data_hora, JSON.stringify(itens), valorTotal, custoTotal, barbeiro_id || null]
        );

        return res.status(200).json({
          success: true,
          comanda_id: comandaResult.rows[0].id,
          itens,
          valor_total: valorTotal,
        });
      }

      return res.status(405).json({ error: 'Método não permitido' });
    }

    // ---- Atendimentos: comportamento original (sem alteração) ----
    if (req.method === 'GET') {
      const { telefone } = req.query;

      if (telefone) {
        const result = await client.query(
          `SELECT a.*, c.nome, c.telefone FROM atendimentos a
           JOIN clientes c ON c.id = a.cliente_id
           WHERE c.telefone = $1
           ORDER BY a.data_hora DESC LIMIT 50`,
          [telefone]
        );
        return res.status(200).json({ success: true, atendimentos: result.rows });
      }

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
