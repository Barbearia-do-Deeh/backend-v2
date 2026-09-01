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
// "coberto"/"avulso" e calcula o valor avulso — mesma regra de api/atendimentos.js,
// só que aqui não mexe em saldo_ciclo de novo (o desconto já aconteceu no
// agendamento, isso aqui é só pra classificar o registro financeiro).
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
  const formaPagamento = avulsos.length === 0 ? 'pacote' : (cobertos.length === 0 ? 'avulso' : 'misto');
  return { cobertos, avulsos, valorCobrado, formaPagamento };
}

// Grava (ou atualiza) o registro definitivo em `atendimentos` quando o status
// vira 'compareceu'; remove o registro se sair de 'compareceu' pra qualquer
// outro status. Best-effort: erro aqui não derruba a resposta de marcar-presença
// (o status no Calendar já foi salvo, que é a ação principal) — só loga.
async function sincronizarAtendimento(evento, status, metodoPagamento) {
  const priv = evento.extendedProperties?.private || {};
  const eventId = evento.id;

  if (status !== 'compareceu') {
    await pool.query(`DELETE FROM atendimentos WHERE event_id = $1`, [eventId]);
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

  const { cobertos, avulsos, valorCobrado, formaPagamento } = calcularCoberturaEAvulso(
    priv.servico, priv.pacote_usado
  );

  const dataHora = evento.start?.dateTime || evento.start?.date || new Date().toISOString();
  const barbeiroId = priv.barbeiro_id || null;

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
        valor_produtos, produtos_consumidos, barbeiro_id, metodo_pagamento)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (event_id) DO UPDATE SET
       servicos = EXCLUDED.servicos,
       forma_pagamento = EXCLUDED.forma_pagamento,
       valor_cobrado = EXCLUDED.valor_cobrado,
       valor_produtos = EXCLUDED.valor_produtos,
       produtos_consumidos = EXCLUDED.produtos_consumidos,
       barbeiro_id = EXCLUDED.barbeiro_id,
       metodo_pagamento = COALESCE(EXCLUDED.metodo_pagamento, atendimentos.metodo_pagamento)
     RETURNING id`,
    [
      clienteId, eventId, dataHora, JSON.stringify([...cobertos, ...avulsos]),
      formaPagamento, valorCobrado, valorProdutos, produtosConsumidos, barbeiroId,
      metodoPagamento || null,
    ]
  );

  if (comandaResult.rows.length > 0) {
    await pool.query(`UPDATE comandas SET atendimento_id = $1 WHERE id = $2`,
      [insertResult.rows[0].id, comandaResult.rows[0].id]);
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
  // Faturamento estimado do dia continua contando tudo (é só uma estimativa em tempo
  // real) — o número já sem falta e já batendo com o financeiro histórico é o
  // /api/financeiro (que lê da tabela atendimentos, alimentada pelo marcar-presença).
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

  // Busca o evento primeiro pra não perder telefone/servico/preco/barbeiro_id já
  // gravados — o patch do Calendar substitui o objeto extendedProperties.private
  // inteiro, então precisa mandar de volta tudo que já tinha + o status novo.
  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const privateAtual = evento.extendedProperties?.private || {};
  const novoPrivate = { ...privateAtual, status };

  // Falta não deveria custar o crédito do pacote — devolve o saldo que tinha
  // sido reservado no momento do agendamento (ver criarAgendamento em
  // api/agendar.js). pacote_estornado evita devolver duas vezes se o status
  // for alternado (ex: Faltou -> Compareceu -> Faltou de novo).
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

  // Registro financeiro definitivo — best-effort, não derruba a resposta se falhar
  // (o status já foi salvo no Calendar, que é a ação que o admin pediu).
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
// USO PONTUAL: recupera pro financeiro os agendamentos já marcados "Compareceu"
// ANTES de sincronizarAtendimento existir (o código antigo nunca gravava nada em
// `atendimentos`). Fica dentro deste arquivo (em vez de um api/*.js novo) de
// propósito — o plano Hobby da Vercel tem teto de 12 funções serverless por
// deploy, e cada arquivo em api/ conta como uma. Depois de rodar uma vez e
// conferir que o financeiro bateu, pode remover este bloco e a constante do
// secret (não é obrigatório, é só faxina).
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
// Reaproveitados pelo backfill (api/backfill-atendimentos.js) — não muda o
// comportamento do endpoint em si, só expõe essas funções pra outro arquivo.
module.exports.getCalendarClient = getCalendarClient;
module.exports.sincronizarAtendimento = sincronizarAtendimento;
module.exports.CALENDAR_ID = CALENDAR_ID;
