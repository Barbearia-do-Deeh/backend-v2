// api/agenda-hoje.js
// GET /api/agenda-hoje?data=dd/mm/aaaa (data é opcional, default = hoje)
// USO: painel admin. Retorna os eventos reais do Google Calendar do dia,
// com nome do cliente, serviço e valor extraídos do evento (criado pelo agendar.js).
// Diferente do /api/disponibilidade (que só retorna horários ocupados, sem detalhes,
// pra não vazar dado de cliente no fluxo público de agendamento).
//
// POST /api/agenda-hoje?tipo=marcar-presenca { eventId, status }
// status: 'compareceu' | 'faltou' | 'pendente'. Grava no próprio evento do Calendar
// (extendedProperties.private.status), sem precisar de tabela nova pra isso. Usado
// pela Agenda do admin pra saber quem veio e quem faltou — e, por consequência,
// excluir faltas do fechamento por barbeiro (ver api/financeiro.js).
//
// ATENDIMENTO DEFINITIVO (financeiro histórico): só quando status === 'compareceu'
// é que o atendimento vira uma linha permanente na tabela `atendimentos` — é essa
// tabela (não o Calendar) que alimenta api/financeiro.js e o faturamento
// anual/semestral. Se o status sair de 'compareceu' depois (voltou pra pendente ou
// virou falta), a linha é removida — falta/desmarcação não é faturamento.
// Idempotente via coluna `event_id` (UNIQUE): alternar o status várias vezes não
// duplica registro.
//
// RAZÃO FINANCEIRO (`lancamentos_financeiros`): espelha o mesmo ciclo de vida do
// `atendimentos` (nasce/atualiza/some junto), mas separa duas coisas que o Calendar
// misturava: `valor` (o que o cliente de fato pagou nessa visita — zero se 100%
// coberto por pacote) e `valor_referencia` (preço de TABELA de tudo que foi
// realizado, cobertos ou não). api/financeiro.js usa `valor_referencia` pra
// calcular comissão do barbeiro — ele presta o serviço independente de como o
// cliente pagou.
//
// Se o agendamento tinha descontado saldo de pacote (ver criarAgendamento em
// api/agendar.js — o desconto acontece JÁ no agendamento, não espera "Compareceu"),
// marcar "faltou" devolve esse crédito automaticamente: falta não deveria custar
// o pacote do cliente.
const { google } = require('googleapis');
const pool = require('../lib/db');
const { CALENDAR_ID_PADRAO } = require('../lib/config-negocio');
const { campoSaldo, normalizarServicos, precoAvulso } = require('../lib/pacotes');
const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    // precisa de escopo de escrita (não só readonly) por causa do marcar-presenca
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// Devolve pro saldo_ciclo o que tinha sido descontado num agendamento.
// `privateAtual` é o extendedProperties.private do evento — precisa ter
// `pacote_usado` (JSON gravado no momento do agendamento por api/agendar.js)
// e `telefone`. Idempotente via `pacote_estornado` (setado pelo chamador
// depois que essa função roda) — evita devolver duas vezes se o status for
// alternado entre Faltou/Compareceu várias vezes.
async function devolverSaldoPacote(privateAtual) {
  if (!privateAtual?.pacote_usado || privateAtual.pacote_estornado === 'true') return;
  const usado = JSON.parse(privateAtual.pacote_usado);
  const telefoneLimpo = privateAtual.telefone;
  if (!telefoneLimpo) return;

  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    const result = await dbClient.query(`SELECT id FROM clientes WHERE telefone = $1 FOR UPDATE`, [telefoneLimpo]);
    if (result.rows.length === 0) { await dbClient.query('ROLLBACK'); return; }
    const clienteId = result.rows[0].id;

    const setClauses = [];
    const values = [clienteId];
    let i = 2;
    for (const [campo, qtd] of Object.entries(usado)) {
      if (campo === 'sobrancelha_restante') {
        setClauses.push(`${campo} = true`);
      } else {
        setClauses.push(`${campo} = ${campo} + $${i}`);
        values.push(qtd);
        i++;
      }
    }
    if (setClauses.length > 0) {
      await dbClient.query(`UPDATE saldo_ciclo SET ${setClauses.join(', ')} WHERE cliente_id = $1`, values);
    }
    await dbClient.query('COMMIT');
  } catch (err) {
    await dbClient.query('ROLLBACK');
    throw err;
  } finally {
    dbClient.release();
  }
}

// A partir do serviço pedido (private.servico) e do que já tinha sido coberto
// pelo pacote no agendamento (private.pacote_usado), separa o que é
// "coberto"/"avulso" e calcula os dois valores que o razão precisa: o que foi
// de fato cobrado do cliente (valorCobrado, considera só os avulsos) e o preço
// de tabela de TUDO que foi realizado (valorReferencia, base de comissão do
// barbeiro — independe de pacote).
function calcularCoberturaEAvulso(servicoStr, pacoteUsadoStr) {
  const chaves = normalizarServicos(servicoStr);
  const restante = pacoteUsadoStr ? JSON.parse(pacoteUsadoStr) : {};
  const cobertos = [];
  const avulsos = [];

  for (const chave of chaves) {
    const campo = campoSaldo(chave); // undefined pra 'corte_kids' — sempre avulso
    if (!campo) { avulsos.push(chave); continue; }
    if (campo === 'sobrancelha_restante') {
      if (restante[campo]) { cobertos.push(chave); restante[campo] = false; }
      else avulsos.push(chave);
    } else {
      if (restante[campo] > 0) { cobertos.push(chave); restante[campo] -= 1; }
      else avulsos.push(chave);
    }
  }

  const valorCobrado = precoAvulso(avulsos);
  const valorReferencia = precoAvulso([...cobertos, ...avulsos]);
  const formaPagamento = avulsos.length === 0 ? 'pacote' : (cobertos.length === 0 ? 'avulso' : 'misto');
  return { cobertos, avulsos, valorCobrado, valorReferencia, formaPagamento };
}

// Grava (ou atualiza) o registro definitivo em `atendimentos` E os lançamentos
// espelhados em `lancamentos_financeiros` quando o status vira 'compareceu';
// remove os dois se sair de 'compareceu' pra qualquer outro status. Best-effort:
// erro aqui não derruba a resposta de marcar-presença (o status no Calendar já
// foi salvo, que é a ação principal) — só loga.
async function sincronizarAtendimento(evento, status, metodoPagamento) {
  const priv = evento.extendedProperties?.private || {};
  const eventId = evento.id;

  if (status !== 'compareceu') {
    await pool.query(`DELETE FROM atendimentos WHERE event_id = $1`, [eventId]);
    await pool.query(
      `DELETE FROM lancamentos_financeiros WHERE origem_tipo = 'atendimento' AND origem_id = $1`,
      [eventId]
    );
    return;
  }

  const telefoneLimpo = priv.telefone;
  if (!telefoneLimpo) {
    console.error('sincronizarAtendimento: evento sem telefone, pulando registro financeiro. eventId=', eventId);
    return;
  }

  const clienteResult = await pool.query('SELECT id FROM clientes WHERE telefone = $1', [telefoneLimpo]);
  if (clienteResult.rows.length === 0) {
    console.error('sincronizarAtendimento: cliente não encontrado pro telefone', telefoneLimpo, 'eventId=', eventId);
    return;
  }
  const clienteId = clienteResult.rows[0].id;

  const { cobertos, avulsos, valorCobrado, valorReferencia, formaPagamento } = calcularCoberturaEAvulso(
    priv.servico, priv.pacote_usado
  );

  const dataHora = evento.start?.dateTime || evento.start?.date || new Date().toISOString();
  const dataCompetencia = dataHora.slice(0, 10);
  const barbeiroId = priv.barbeiro_id || null;
  const metodoAtual = metodoPagamento || null;

  // Produtos vendidos junto (comanda criada no momento do agendamento com o
  // mesmo telefone + mesmo horário de início do evento — casam exatos porque
  // agendar.js usa a mesma string ISO pros dois).
  let valorProdutos = 0;
  let produtosConsumidos = null;
  const comandaResult = await pool.query(
    `SELECT id, produtos, valor_total FROM comandas
     WHERE telefone = $1 AND data_hora = $2 AND atendimento_id IS NULL`,
    [telefoneLimpo, dataHora]
  );
  if (comandaResult.rows.length > 0) {
    const comanda = comandaResult.rows[0];
    valorProdutos = Number(comanda.valor_total) || 0;
    produtosConsumidos = comanda.produtos;
  }

  const insertResult = await pool.query(
    `INSERT INTO atendimentos
       (cliente_id, event_id, data_hora, servicos, forma_pagamento, valor_cobrado,
        valor_referencia, valor_produtos, produtos_consumidos, barbeiro_id, metodo_pagamento)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (event_id) DO UPDATE SET
       servicos = EXCLUDED.servicos,
       forma_pagamento = EXCLUDED.forma_pagamento,
       valor_cobrado = EXCLUDED.valor_cobrado,
       valor_referencia = EXCLUDED.valor_referencia,
       valor_produtos = EXCLUDED.valor_produtos,
       produtos_consumidos = EXCLUDED.produtos_consumidos,
       barbeiro_id = EXCLUDED.barbeiro_id,
       metodo_pagamento = COALESCE(EXCLUDED.metodo_pagamento, atendimentos.metodo_pagamento)
     RETURNING id`,
    [
      clienteId, eventId, dataHora, JSON.stringify([...cobertos, ...avulsos]),
      formaPagamento, valorCobrado, valorReferencia, valorProdutos, produtosConsumidos, barbeiroId,
      metodoAtual,
    ]
  );

  if (comandaResult.rows.length > 0) {
    await pool.query(`UPDATE comandas SET atendimento_id = $1 WHERE id = $2`,
      [insertResult.rows[0].id, comandaResult.rows[0].id]);
  }

  // ---- Razão financeiro (lancamentos_financeiros) ----
  await pool.query(
    `INSERT INTO lancamentos_financeiros
       (tipo, status, valor, valor_referencia, metodo_pagamento, data_competencia,
        data_caixa, cliente_id, barbeiro_id, origem_tipo, origem_id)
     VALUES ('receita_servico', 'confirmado', $1, $2, $3, $4, $4, $5, $6, 'atendimento', $7)
     ON CONFLICT (origem_tipo, origem_id, tipo) DO UPDATE SET
       valor = EXCLUDED.valor,
       valor_referencia = EXCLUDED.valor_referencia,
       metodo_pagamento = COALESCE(EXCLUDED.metodo_pagamento, lancamentos_financeiros.metodo_pagamento),
       data_competencia = EXCLUDED.data_competencia,
       data_caixa = EXCLUDED.data_caixa,
       cliente_id = EXCLUDED.cliente_id,
       barbeiro_id = EXCLUDED.barbeiro_id`,
    [valorCobrado, valorReferencia, metodoAtual, dataCompetencia, clienteId, barbeiroId, eventId]
  );

  if (valorProdutos > 0) {
    await pool.query(
      `INSERT INTO lancamentos_financeiros
         (tipo, status, valor, valor_referencia, metodo_pagamento, data_competencia,
          data_caixa, cliente_id, barbeiro_id, origem_tipo, origem_id)
       VALUES ('receita_produto', 'confirmado', $1, $1, $2, $3, $3, $4, $5, 'atendimento', $6)
       ON CONFLICT (origem_tipo, origem_id, tipo) DO UPDATE SET
         valor = EXCLUDED.valor,
         valor_referencia = EXCLUDED.valor_referencia,
         metodo_pagamento = COALESCE(EXCLUDED.metodo_pagamento, lancamentos_financeiros.metodo_pagamento),
         data_competencia = EXCLUDED.data_competencia,
         data_caixa = EXCLUDED.data_caixa,
         cliente_id = EXCLUDED.cliente_id,
         barbeiro_id = EXCLUDED.barbeiro_id`,
      [valorProdutos, metodoAtual, dataCompetencia, clienteId, barbeiroId, eventId]
    );
  } else {
    // Se antes tinha produto e agora não tem mais (comanda removida/zerada),
    // limpa o lançamento órfão em vez de deixar duplicado.
    await pool.query(
      `DELETE FROM lancamentos_financeiros WHERE origem_tipo = 'atendimento' AND origem_id = $1 AND tipo = 'receita_produto'`,
      [eventId]
    );
  }
}

function parseDescricao(desc) {
  const result = { telefone: null, valor: 0 };
  if (!desc) return result;
  const tel = desc.match(/WhatsApp:\s*(.+)/);
  const valor = desc.match(/Valor:\s*R?\$?\s*([\d.,]+)/);
  if (tel) result.telefone = tel[1].trim();
  if (valor) result.valor = parseFloat(valor[1].replace(',', '.')) || 0;
  return result;
}
function parseNomeServico(summary) {
  // Formato gravado pelo agendar.js: "✂️ <servico> — <nome>"
  const partes = (summary || '').split(' — ');
  const nome = partes.length > 1 ? partes[1].trim() : '';
  const servico = partes.length > 0 ? partes[0].replace(/^[^\p{L}]+/u, '').trim() : (summary || '');
  return { nome, servico };
}

async function listarAgenda(req, res) {
  const dataParam = req.query.data;
  let dataISO;
  if (dataParam) {
    const [dia, mes, ano] = dataParam.split('/');
    dataISO = `${ano}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
  } else {
    dataISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // yyyy-mm-dd
  }
  const calendar = getCalendarClient();
  const timeMin = `${dataISO}T00:00:00-03:00`;
  const timeMax = `${dataISO}T23:59:59-03:00`;
  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const eventos = (response.data.items || [])
    .filter((ev) => ev.start && ev.start.dateTime) // ignora eventos de dia inteiro
    .map((ev) => {
      const { nome, servico } = parseNomeServico(ev.summary);
      const info = parseDescricao(ev.description);
      const priv = ev.extendedProperties?.private || {};
      const horaInicio = new Date(ev.start.dateTime).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });
      const horaFim = new Date(ev.end.dateTime).toLocaleTimeString('pt-BR', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo',
      });
      return {
        id: ev.id,
        nome: nome || 'Cliente',
        servico: servico || ev.summary || '',
        horaInicio,
        horaFim,
        valor: info.valor,
        telefone: info.telefone,
        status: priv.status || 'pendente',
      };
    });
  const faturamentoEstimado = eventos.reduce((s, e) => s + (e.valor || 0), 0);
  return res.status(200).json({
    success: true,
    data: dataISO,
    eventos,
    total: eventos.length,
    faturamento_estimado: faturamentoEstimado,
  });
}

async function marcarPresenca(req, res) {
  const { eventId, status, metodo_pagamento } = req.body || {};
  if (!eventId || !['compareceu', 'faltou', 'pendente'].includes(status)) {
    return res.status(400).json({ error: 'eventId e status (compareceu|faltou|pendente) são obrigatórios' });
  }

  const calendar = getCalendarClient();

  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const privateAtual = evento.extendedProperties?.private || {};
  const novoPrivate = { ...privateAtual, status };

  if (status === 'faltou') {
    try {
      await devolverSaldoPacote(privateAtual);
      if (privateAtual.pacote_usado) novoPrivate.pacote_estornado = 'true';
    } catch (err) {
      console.error('Erro ao devolver saldo de pacote:', err.message);
      return res.status(500).json({ error: 'Não foi possível devolver o saldo do pacote: ' + err.message });
    }
  }

  try {
    await calendar.events.patch({
      calendarId: CALENDAR_ID,
      eventId,
      resource: {
        extendedProperties: {
          private: novoPrivate,
        },
      },
    });
  } catch (err) {
    console.error('Erro ao gravar status no evento:', err.message);
    return res.status(500).json({ error: 'Não foi possível salvar no Google Calendar: ' + err.message });
  }

  let avisoFinanceiro = null;
  try {
    await sincronizarAtendimento({ ...evento, extendedProperties: { private: novoPrivate } }, status, metodo_pagamento);
  } catch (err) {
    console.error('Erro ao sincronizar atendimento financeiro:', err.message);
    avisoFinanceiro = 'Status salvo, mas houve um erro ao atualizar o financeiro: ' + err.message;
  }

  return res.status(200).json({ success: true, eventId, status, aviso_financeiro: avisoFinanceiro });
}

// GET /api/agenda-hoje?tipo=backfill&secret=...&mes=8&ano=2026
const BACKFILL_SECRET = 'deeh-backfill-2026';

async function backfillAtendimentos(req, res) {
  if (req.query.secret !== BACKFILL_SECRET) {
    return res.status(403).json({ error: 'Segredo inválido' });
  }

  const hoje = new Date();
  const mes = parseInt(req.query.mes, 10) || (hoje.getMonth() + 1);
  const ano = parseInt(req.query.ano, 10) || hoje.getFullYear();

  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fimDate = new Date(Date.UTC(ano, mes, 0));
  const fim = fimDate.toISOString().slice(0, 10);

  const calendar = getCalendarClient();
  const response = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: `${inicio}T00:00:00-03:00`,
    timeMax: `${fim}T23:59:59-03:00`,
    singleEvents: true,
    orderBy: 'startTime',
  });

  const eventos = response.data.items || [];
  const compareceram = eventos.filter(
    (ev) => (ev.extendedProperties?.private?.status) === 'compareceu'
  );

  let gravados = 0;
  const erros = [];
  for (const evento of compareceram) {
    try {
      await sincronizarAtendimento(evento, 'compareceu', null);
      gravados++;
    } catch (err) {
      erros.push({ eventId: evento.id, erro: err.message });
    }
  }

  return res.status(200).json({
    success: true,
    periodo: { mes, ano, inicio, fim },
    total_eventos_no_periodo: eventos.length,
    marcados_compareceu: compareceram.length,
    gravados_com_sucesso: gravados,
    erros,
  });
}

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.query.tipo === 'marcar-presenca') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
      return await marcarPresenca(req, res);
    }

    if (req.query.tipo === 'backfill') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Use GET' });
      return await backfillAtendimentos(req, res);
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });
    return await listarAgenda(req, res);
  } catch (err) {
    console.error('Erro em /api/agenda-hoje:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = handler;
module.exports.getCalendarClient = getCalendarClient;
module.exports.sincronizarAtendimento = sincronizarAtendimento;
module.exports.CALENDAR_ID = CALENDAR_ID;
