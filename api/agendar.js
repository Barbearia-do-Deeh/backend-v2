const { google } = require('googleapis');
const webpush = require('web-push');
const pool = require('../lib/db');
const { ENDERECO, WHATSAPP_ADMIN, CALENDAR_ID_PADRAO, VAPID_SUBJECT_PADRAO } = require('../lib/config-negocio');
const { saldoInicial, campoSaldo } = require('../lib/pacotes');
const { VALOR_PLANO } = require('../lib/financas');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || VAPID_SUBJECT_PADRAO;
const ADMIN_TELEFONE = WHATSAPP_ADMIN; // mesmo identificador usado no admin.html pra se inscrever

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ---- Pacote: saldo é descontado JÁ NO AGENDAMENTO (não espera "Compareceu") ----
// Se depois o cliente faltar ou cancelar, o crédito volta — ver devolverSaldoPacote()
// aqui, e a mesma lógica espelhada em api/agenda-hoje.js (marcarPresenca).

// Normaliza os nomes de serviço do app do cliente (ex: "Corte + Barba") pros
// identificadores internos que lib/pacotes.js espera. "Corte Kids" nunca é
// coberto por pacote — sempre avulso, com preço próprio.
function servicosParaChaves(servicoStr) {
  const MAPA = { Corte: 'corte', Barba: 'barba', Pezinho: 'pezinho', Sobrancelha: 'sobrancelha' };
  return (servicoStr || '').split(' + ').map(s => MAPA[s.trim()] || null);
}

// Devolve pro saldo_ciclo o que tinha sido descontado num agendamento (falta
// ou cancelamento). `privateAtual` é o extendedProperties.private do evento —
// precisa ter `pacote_usado` (JSON gravado no momento do agendamento) e
// `telefone`. Idempotente: não desconta duas vezes o mesmo pacote_usado,
// desde que o chamador marque pacote_estornado depois de chamar essa função
// (agenda-hoje.js faz isso; cancelamento não precisa, porque o evento é apagado).
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

// ---- Horário de funcionamento (fonte da verdade no SERVIDOR — não depende do front) ----
// Domingo(0), segunda(1) e terça(2): fechado. Demais dias: faixa abre/fecha em minutos desde 00:00.
const DIAS_FECHADOS = [0, 1, 2];
const HORARIO_POR_DIA = {
  3: { abre: '09:00', fecha: '19:00' }, // quarta
  4: { abre: '09:00', fecha: '19:00' }, // quinta
  5: { abre: '09:00', fecha: '19:00' }, // sexta
  6: { abre: '08:00', fecha: '17:00' }, // sábado
};

// Aniversário sincronizado do Google Contacts vem como evento com eventType 'birthday'
// (e não deve bloquear horário — é só um lembrete, não um compromisso).
function ehAniversario(ev) {
  return ev.eventType === 'birthday';
}

function minutosDoDia(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

// Retorna null se o dia/horário está dentro do funcionamento, ou uma mensagem de erro.
function validarHorarioFuncionamento(ano, mes, dia, horario, duracaoMin) {
  const diaSemana = new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay();
  if (DIAS_FECHADOS.includes(diaSemana)) {
    return 'A barbearia não abre nesse dia.';
  }
  const janela = HORARIO_POR_DIA[diaSemana];
  if (!janela) {
    return 'A barbearia não abre nesse dia.';
  }
  const inicioMin = minutosDoDia(horario);
  const fimMin = inicioMin + duracaoMin;
  if (inicioMin < minutosDoDia(janela.abre) || fimMin > minutosDoDia(janela.fecha)) {
    return `Horário fora do funcionamento (${janela.abre} às ${janela.fecha} nesse dia).`;
  }
  return null;
}

function addDias(data, dias) {
  const d = new Date(data);
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

// ---- GET ?tipo=meus-agendamentos&telefone=... ----
async function listarMeusAgendamentos(req, res) {
  const { telefone } = req.query;
  if (!telefone) {
    return res.status(400).json({ error: 'telefone é obrigatório' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();
  const now = new Date();
  const timeMax = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const result = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: timeMax.toISOString(),
    privateExtendedProperty: [`telefone=${telefoneLimpo}`],
    singleEvents: true,
    orderBy: 'startTime',
  });

  const agendamentos = (result.data.items || []).map(ev => {
    const startStr = ev.start?.dateTime || ev.start?.date || '';
    const [dataPart, horaPart] = startStr.split('T');
    const [ano, mes, dia] = (dataPart || '').split('-');
    const horario = horaPart ? horaPart.slice(0, 5) : null;
    const priv = ev.extendedProperties?.private || {};
    return {
      eventId: ev.id,
      servico: priv.servico || ev.summary || '',
      data: dia && mes && ano ? `${dia}/${mes}/${ano}` : null,
      horario,
      preco: priv.preco || null,
      status: priv.status || 'pendente',
    };
  });

  return res.status(200).json({ success: true, agendamentos });
}

function extrairDataDDMMAAAA(evento) {
  const startStr = evento.start?.dateTime || evento.start?.date || '';
  const dataPart = startStr.split('T')[0];
  const [ano, mes, dia] = (dataPart || '').split('-');
  if (!ano || !mes || !dia) return null;
  return `${dia}/${mes}/${ano}`;
}

async function notificarFilaEspera(evento) {
  const dataStr = extrairDataDDMMAAAA(evento);
  if (!dataStr) return;

  const barbeiroDoEvento = evento.extendedProperties?.private?.barbeiro_id || null;

  const filaResult = await pool.query(
    `SELECT id, telefone, nome, servico FROM fila_espera
     WHERE data = $1 AND notificado = false
       AND (barbeiro_id IS NULL OR barbeiro_id::text = $2)`,
    [dataStr, barbeiroDoEvento]
  );
  if (!filaResult.rows.length) return;

  for (const item of filaResult.rows) {
    try {
      const subRow = await pool.query(
        'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
        [item.telefone]
      );
      if (subRow.rows.length === 0) continue;

      const payload = JSON.stringify({
        title: 'Vaga aberta! ✂️',
        body: `${item.nome ? item.nome + ', abriu' : 'Abriu'} um horário no dia ${dataStr}${item.servico ? ' pra ' + item.servico : ''}. Corre lá no app!`,
        icon: '/icon-192.png',
      });
      await webpush.sendNotification(subRow.rows[0].subscription, payload);
      await pool.query('UPDATE fila_espera SET notificado = true WHERE id = $1', [item.id]);
    } catch (err) {
      console.error('Erro ao notificar fila de espera do telefone', item.telefone, err.message);
    }
  }
}

// ---- POST ?tipo=cancelar { eventId, telefone } ----
async function cancelarAgendamento(req, res) {
  const { eventId, telefone } = req.body;
  if (!eventId || !telefone) {
    return res.status(400).json({ error: 'eventId e telefone são obrigatórios' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();

  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const telefoneDoEvento = evento.extendedProperties?.private?.telefone;
  if (telefoneDoEvento !== telefoneLimpo) {
    return res.status(403).json({ error: 'Este agendamento não pertence a esse telefone' });
  }

  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId });

  // Se esse agendamento tinha consumido saldo de pacote, devolve o crédito —
  // cancelamento não deveria custar o crédito do cliente, igual à falta.
  try {
    await devolverSaldoPacote(evento.extendedProperties?.private || {});
  } catch (err) {
    console.error('Erro ao devolver saldo de pacote no cancelamento:', err.message);
  }

  try {
    await notificarFilaEspera(evento);
  } catch (err) {
    console.error('Erro ao notificar fila de espera:', err.message);
  }

  return res.status(200).json({ success: true });
}

// ---- POST ?tipo=confirmar { eventId, telefone } ----
async function confirmarPresenca(req, res) {
  const { eventId, telefone } = req.body;
  if (!eventId || !telefone) {
    return res.status(400).json({ error: 'eventId e telefone são obrigatórios' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();

  let evento;
  try {
    const evResp = await calendar.events.get({ calendarId: CALENDAR_ID, eventId });
    evento = evResp.data;
  } catch (err) {
    return res.status(404).json({ error: 'Agendamento não encontrado' });
  }

  const privateAtual = evento.extendedProperties?.private || {};
  if (privateAtual.telefone !== telefoneLimpo) {
    return res.status(403).json({ error: 'Este agendamento não pertence a esse telefone' });
  }

  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    resource: {
      extendedProperties: {
        private: { ...privateAtual, status: 'confirmado' },
      },
    },
  });

  return res.status(200).json({ success: true });
}

// ---- POST ?tipo=fila-espera { nome, telefone, data, servico } ----
async function entrarNaFila(req, res) {
  const { nome, telefone, data, servico, barbeiro_id } = req.body;
  if (!nome || !telefone || !data) {
    return res.status(400).json({ error: 'nome, telefone e data são obrigatórios' });
  }
  const telefoneLimpo = telefone.replace(/\D/g, '');

  await pool.query(
    `INSERT INTO fila_espera (nome, telefone, data, servico, barbeiro_id) VALUES ($1, $2, $3, $4, $5)`,
    [nome, telefoneLimpo, data, servico || null, barbeiro_id || null]
  );

  return res.status(200).json({ success: true });
}

// ---- POST (padrão, sem tipo) — criar agendamento ----
async function criarAgendamento(req, res) {
  const { nome, telefone, servico, data, horario, duracao, preco, produtos, barbeiro_id } = req.body;
  if (!nome || !telefone || !servico || !data || !horario) {
    return res.status(400).json({ error: 'Dados incompletos' });
  }

  const telefoneLimpo = telefone.replace(/\D/g, '');

  const calendar = getCalendarClient();

  const [dia, mes, ano] = data.split('/');
  const [hora, minuto] = horario.split(':');
  const duracaoMin = duracao === '15 min' ? 15 : 60;

  // ---- Validação de dia/horário de funcionamento — TRAVA NO SERVIDOR ----
  // Antes essa regra só existia no front-end (index.html). Se o front tivesse
  // qualquer brecha (bug de fuso, cache antigo, tela de horário fixo etc.), o
  // back-end aceitava o agendamento numa boa — foi o que deixou passar
  // agendamento em dia fechado (terça-feira). Agora o servidor recusa sempre,
  // não importa o que o front mandar.
  const erroHorario = validarHorarioFuncionamento(ano, mes, dia, horario, duracaoMin);
  if (erroHorario) {
    return res.status(400).json({ error: erroHorario });
  }

  const startUTC = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto));
  const endUTC = new Date(startUTC.getTime() + duracaoMin * 60000);

  // ---- Correção de fuso pra comparação de conflito ----
  // startUTC/endUTC acima tratam "13:00" como se já fosse UTC (é um truque só
  // pra montar a STRING enviada ao Google com toISO(), que troca o "Z" por
  // "-03:00" — isso sim fica correto). Só que pra COMPARAR contra os horários
  // reais dos eventos existentes (que o Google já devolve no fuso certo,
  // portanto 3h à frente desse valor "cru"), precisa somar as 3h de volta.
  // Sem isso, a checagem de conflito compara como se o cliente tivesse
  // escolhido um horário 3h mais cedo do que realmente escolheu — foi isso
  // que deixava agendar por cima de compromissos que começavam mais tarde
  // no dia (o sistema achava que ainda não tinha chegado no horário deles).
  const FUSO_SP_MS = 3 * 60 * 60 * 1000;
  const startReal = startUTC.getTime() + FUSO_SP_MS;
  const endReal = endUTC.getTime() + FUSO_SP_MS;

  const toISO = (d) => d.toISOString().replace('Z', '-03:00').slice(0, 19) + '-03:00';

  let itensProduto = [];
  let valorProdutos = 0;
  if (Array.isArray(produtos) && produtos.length > 0) {
    const ids = produtos.map(p => p.id);
    const result = await pool.query(
      `SELECT id, nome, preco FROM produtos WHERE id = ANY($1::int[]) AND ativo = true`,
      [ids]
    );
    const catalogo = new Map(result.rows.map(p => [p.id, p]));
    for (const p of produtos) {
      const info = catalogo.get(p.id);
      if (!info) continue;
      const quantidade = p.quantidade && p.quantidade > 0 ? p.quantidade : 1;
      valorProdutos += Number(info.preco) * quantidade;
      itensProduto.push({ id: info.id, nome: info.nome, preco: Number(info.preco), quantidade });
    }
  }

  const resumoProdutos = itensProduto.length
    ? `\n🛍 Produtos: ${itensProduto.map(i => `${i.nome} x${i.quantidade}`).join(', ')} (R$ ${valorProdutos.toFixed(2).replace('.', ',')} — pago na hora)`
    : '';

  // ---- Pacote: desconta saldo AGORA, no agendamento (Opção B) ----
  // Só mexe em quem já tem plano ativo — cliente sem plano segue igual a
  // sempre foi (cobrança avulsa normal, sem passar por nada disso).
  const chavesServico = servicosParaChaves(servico); // ex: ['corte','barba']; 'Corte Kids' vira null
  const pacoteUsado = {};       // o que foi de fato descontado agora (pra devolver depois, se faltar/cancelar)
  let avisoNovoPacote = null;   // preenchido quando algum serviço pedido já estourou o saldo do ciclo atual

  const dbClientPacote = await pool.connect();
  try {
    await dbClientPacote.query('BEGIN');

    const clienteResult = await dbClientPacote.query(
      `SELECT c.id, c.plano, c.subtipo_essencial, c.data_fim_ciclo,
              s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
       FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id
       WHERE c.telefone = $1 FOR UPDATE`,
      [telefoneLimpo]
    );

    if (clienteResult.rows.length > 0 && clienteResult.rows[0].plano && clienteResult.rows[0].plano !== 'nenhum') {
      let cliente = clienteResult.rows[0];

      // Renova o ciclo se já venceu (mesma regra usada em api/atendimentos.js)
      const hojeStr = new Date().toISOString().slice(0, 10);
      if (cliente.data_fim_ciclo && hojeStr > cliente.data_fim_ciclo) {
        const novoInicio = hojeStr;
        const novoFim = addDias(hojeStr, 30);
        const saldoNovo = saldoInicial(cliente.plano, cliente.subtipo_essencial);
        await dbClientPacote.query(
          `UPDATE clientes SET data_inicio_ciclo = $1, data_fim_ciclo = $2 WHERE id = $3`,
          [novoInicio, novoFim, cliente.id]
        );
        await dbClientPacote.query(
          `UPDATE saldo_ciclo SET cortes_restantes = $1, barbas_restantes = $2,
           pezinhos_restantes = $3, sobrancelha_restante = $4 WHERE cliente_id = $5`,
          [saldoNovo.cortes_restantes, saldoNovo.barbas_restantes, saldoNovo.pezinhos_restantes, saldoNovo.sobrancelha_restante, cliente.id]
        );
        cliente = { ...cliente, ...saldoNovo, data_inicio_ciclo: novoInicio, data_fim_ciclo: novoFim };
      }

      const updates = {};
      for (const chave of chavesServico) {
        const campo = campoSaldo(chave);
        if (!campo) continue; // ex: Corte Kids — nunca usa saldo de pacote

        if (campo === 'sobrancelha_restante') {
          const disponivel = updates[campo] !== undefined ? updates[campo] : cliente.sobrancelha_restante;
          if (disponivel) {
            updates[campo] = false;
            pacoteUsado[campo] = true;
          } else {
            avisoNovoPacote = avisoNovoPacote || { plano: cliente.plano, valor: VALOR_PLANO[cliente.plano] };
          }
        } else {
          const atual = updates[campo] !== undefined ? updates[campo] : cliente[campo];
          if (atual > 0) {
            updates[campo] = atual - 1;
            pacoteUsado[campo] = (pacoteUsado[campo] || 0) + 1;
          } else {
            avisoNovoPacote = avisoNovoPacote || { plano: cliente.plano, valor: VALOR_PLANO[cliente.plano] };
          }
        }
      }

      const setClauses = Object.keys(updates).map((campo, i) => `${campo} = $${i + 2}`);
      if (setClauses.length > 0) {
        await dbClientPacote.query(
          `UPDATE saldo_ciclo SET ${setClauses.join(', ')} WHERE cliente_id = $1`,
          [cliente.id, ...Object.values(updates)]
        );
      }
    }

    await dbClientPacote.query('COMMIT');
  } catch (err) {
    await dbClientPacote.query('ROLLBACK');
    console.error('Erro ao processar saldo de pacote:', err.message);
    // Não derruba o agendamento por causa disso — segue e cobra avulso normal.
  } finally {
    dbClientPacote.release();
  }

  let nomeBarbeiro = '';
  if (barbeiro_id) {
    try {
      const barbeiroResult = await pool.query('SELECT nome FROM barbeiros WHERE id = $1', [barbeiro_id]);
      if (barbeiroResult.rows.length > 0) nomeBarbeiro = barbeiroResult.rows[0].nome;
    } catch (err) {
      console.error('Erro ao buscar nome do barbeiro:', err.message);
    }
  }
  const resumoBarbeiro = nomeBarbeiro ? `\n✂️ Profissional: ${nomeBarbeiro}` : '';

  // ---- Checagem final de conflito, na hora H ----
  // CORREÇÃO: eventos de "dia inteiro" (sem dateTime, só "date" — ex: compromisso
  // pessoal criado direto no Calendar sem marcar hora) antes eram IGNORADOS aqui
  // (`if (!ev.start?.dateTime...) return false`), então o sistema agendava por
  // cima deles sem perceber. Agora um evento de dia inteiro bloqueia o dia todo.
  try {
    const dataISO = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const diaResp = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: `${dataISO}T00:00:00-03:00`,
      timeMax: `${dataISO}T23:59:59-03:00`,
      singleEvents: true,
    });
    const eventosDoDia = diaResp.data.items || [];
    const conflito = eventosDoDia.some((ev) => {
      if (ehAniversario(ev)) return false;
      const barbeiroDoEvento = ev.extendedProperties?.private?.barbeiro_id;
      if (barbeiro_id && barbeiroDoEvento && barbeiroDoEvento !== String(barbeiro_id)) return false;

      // Evento de dia inteiro (sem horário específico) bloqueia o dia todo.
      if (!ev.start?.dateTime || !ev.end?.dateTime) {
        return !!(ev.start?.date || ev.end?.date);
      }

      const evInicio = new Date(ev.start.dateTime).getTime();
      const evFim = new Date(ev.end.dateTime).getTime();
      return startReal < evFim && endReal > evInicio;
    });
    if (conflito) {
      return res.status(409).json({
        error: 'Esse horário acabou de ficar indisponível. Volte e escolha outro horário.',
      });
    }
  } catch (err) {
    console.error('Erro na checagem final de conflito:', err.message);
    return res.status(503).json({
      error: 'Não foi possível confirmar a disponibilidade agora. Tente novamente em instantes.',
    });
  }

  const event = {
    summary: `✂️ ${servico} — ${nome}`,
    description: `📱 WhatsApp: ${telefone}\n💈 Serviço: ${servico}\n💰 Valor: ${preco}\n⏱ Duração: ${duracao || '60 min'}${resumoBarbeiro}${resumoProdutos}`,
    location: ENDERECO,
    start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
    end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
    colorId: '5', // Banana (amarelo)
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 60 },
        { method: 'popup', minutes: 15 },
      ],
    },
    extendedProperties: {
      private: {
        telefone: telefoneLimpo,
        servico,
        preco: preco || '',
        ...(barbeiro_id ? { barbeiro_id: String(barbeiro_id) } : {}),
        ...(Object.keys(pacoteUsado).length ? { pacote_usado: JSON.stringify(pacoteUsado) } : {}),
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event,
  });

  try {
    const subRow = await pool.query(
      'SELECT subscription FROM push_subscriptions WHERE telefone = $1',
      [ADMIN_TELEFONE]
    );
    if (subRow.rows.length > 0) {
      const horaFmt = horario;
      const pushPayload = JSON.stringify({
        title: 'Novo agendamento! ✂️',
        body: `${nome} marcou ${servico} pra ${data} às ${horaFmt}.`,
        icon: '/icon-192.png',
      });
      await webpush.sendNotification(subRow.rows[0].subscription, pushPayload);
    }
  } catch (err) {
    console.error('Erro ao enviar push de novo agendamento:', err.message);
  }

  try {
    const hoje = new Date().toISOString().slice(0, 10);
    const fim = addDias(hoje, 30);
    const clienteResult = await pool.query(
      `INSERT INTO clientes (nome, telefone, plano, subtipo_essencial, data_inicio_ciclo, data_fim_ciclo)
       VALUES ($1, $2, 'nenhum', NULL, $3, $4)
       ON CONFLICT (telefone) DO UPDATE SET nome = EXCLUDED.nome
       RETURNING id`,
      [nome, telefoneLimpo, hoje, fim]
    );
    const clienteId = clienteResult.rows[0].id;
    await pool.query(
      `INSERT INTO saldo_ciclo (cliente_id, cortes_restantes, barbas_restantes, pezinhos_restantes, sobrancelha_restante)
       VALUES ($1, 0, 0, 0, false)
       ON CONFLICT (cliente_id) DO NOTHING`,
      [clienteId]
    );
  } catch (err) {
    console.error('Erro ao gravar cliente:', err.message);
  }

  let comandaId = null;
  if (itensProduto.length > 0) {
    try {
      const comandaResult = await pool.query(
        `INSERT INTO comandas (telefone, data_hora, produtos, valor_total, barbeiro_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [telefoneLimpo, toISO(startUTC), JSON.stringify(itensProduto), valorProdutos, barbeiro_id || null]
      );
      comandaId = comandaResult.rows[0].id;
    } catch (err) {
      console.error('Erro ao salvar comanda de produtos:', err.message);
    }
  }

  return res.status(200).json({
    success: true,
    eventId: response.data.id,
    eventLink: response.data.htmlLink,
    comanda_id: comandaId,
    produtos: itensProduto,
    valor_produtos: valorProdutos,
    aviso_pacote: avisoNovoPacote, // { plano, valor } quando algum serviço já estourou o saldo do ciclo atual
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { tipo } = req.query;

  try {
    if (req.method === 'GET') {
      if (tipo === 'meus-agendamentos') return await listarMeusAgendamentos(req, res);
      return res.status(400).json({ error: 'tipo inválido para GET' });
    }

    if (req.method === 'POST') {
      if (tipo === 'cancelar') return await cancelarAgendamento(req, res);
      if (tipo === 'confirmar') return await confirmarPresenca(req, res);
      if (tipo === 'fila-espera') return await entrarNaFila(req, res);
      return await criarAgendamento(req, res);
    }

    return res.status(405).json({ error: 'Método não permitido' });
  } catch (err) {
    console.error('Erro em /api/agendar:', err.message);
    return res.status(500).json({ error: 'Erro no servidor', details: err.message });
  }
};
