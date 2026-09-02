const { google } = require('googleapis');
const pool = require('../lib/db');
const { ENDERECO, CALENDAR_ID_PADRAO } = require('../lib/config-negocio');
const { saldoInicial, campoSaldo, padraoSemanalPacote, chavesParaServicoTexto } = require('../lib/pacotes');

const PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
const CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const CALENDAR_ID = process.env.CALENDAR_ID || CALENDAR_ID_PADRAO;

function getCalendarClient() {
  const auth = new google.auth.JWT({
    email: CLIENT_EMAIL,
    key: PRIVATE_KEY,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return google.calendar({ version: 'v3', auth });
}

function addDiasISO(dataISO, dias) {
  const d = new Date(dataISO + 'T00:00:00');
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
}

// Mesmo helper usado em agendar.js — o driver do Postgres pode devolver DATE
// como objeto Date, não como string, e comparar direto não funciona.
function paraDataISO(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });

  try {
    const { nome, telefone, servico, dataInicio, horario, duracao, preco, repeticoes, barbeiro_id, intervaloSemanas } = req.body;
    if (!nome || !telefone || !servico || !dataInicio || !horario) {
      return res.status(400).json({ error: 'Dados incompletos' });
    }

    const telefoneLimpo = telefone.replace(/\D/g, '');
    const calendar = getCalendarClient();

    const [diaIni, mesIni, anoIni] = dataInicio.split('/');
    const [hora, minuto] = horario.split(':');
    const duracaoMin = duracao === '15 min' ? 15 : 60;
    const count = parseInt(repeticoes, 10) || 12;
    const intervalo = parseInt(intervaloSemanas, 10) || 1;
    const toISO = (d) => d.toISOString().replace('Z', '-03:00').slice(0, 19) + '-03:00';
    const dataInicioISO = `${anoIni}-${String(mesIni).padStart(2, '0')}-${String(diaIni).padStart(2, '0')}`;

    // ---- Passo 1: decide o serviço de CADA ocorrência e simula o consumo do
    // saldo do pacote pro ciclo inteiro, TUDO em memória, sem gravar nada ainda.
    // Cliente sem plano: mesmo serviço em todas as ocorrências, sem mexer em saldo
    // (igual a sempre foi). Cliente com plano: ignora o "servico" escolhido no
    // formulário e usa padraoSemanalPacote(), girando a cada ocorrência; se o
    // ciclo vencer no meio das ocorrências futuras, renova sozinho (mesma regra
    // de sempre: 30 dias a partir de quando venceu) e reinicia a posição no padrão.
    const dbClient = await pool.connect();
    const ocorrencias = []; // [{ dataISO, servicoTexto, pacoteUsado }]
    try {
      await dbClient.query('BEGIN');
      const clienteResult = await dbClient.query(
        `SELECT c.id, c.plano, c.subtipo_essencial, c.data_inicio_ciclo, c.data_fim_ciclo,
                s.cortes_restantes, s.barbas_restantes, s.pezinhos_restantes, s.sobrancelha_restante
         FROM clientes c LEFT JOIN saldo_ciclo s ON s.cliente_id = c.id
         WHERE c.telefone = $1 FOR UPDATE`,
        [telefoneLimpo]
      );

      const temPlano = clienteResult.rows.length > 0
        && clienteResult.rows[0].plano && clienteResult.rows[0].plano !== 'nenhum';

      if (!temPlano) {
        for (let i = 0; i < count; i++) {
          ocorrencias.push({ dataISO: addDiasISO(dataInicioISO, i * intervalo * 7), servicoTexto: servico, pacoteUsado: null });
        }
      } else {
        const cliente = clienteResult.rows[0];
        const padrao = padraoSemanalPacote(cliente.plano, cliente.subtipo_essencial);

        if (!padrao) {
          // Plano sem padrão semanal reconhecido (não deveria acontecer com os
          // planos atuais) — cai pro comportamento sem plano, não trava nada.
          for (let i = 0; i < count; i++) {
            ocorrencias.push({ dataISO: addDiasISO(dataInicioISO, i * intervalo * 7), servicoTexto: servico, pacoteUsado: null });
          }
        } else {
          let cicloInicio = paraDataISO(cliente.data_inicio_ciclo);
          let cicloFim = paraDataISO(cliente.data_fim_ciclo);
          let saldo = {
            cortes_restantes: cliente.cortes_restantes ?? 0,
            barbas_restantes: cliente.barbas_restantes ?? 0,
            pezinhos_restantes: cliente.pezinhos_restantes ?? 0,
            sobrancelha_restante: !!cliente.sobrancelha_restante,
          };
          let semanaIndex = 0;

          for (let i = 0; i < count; i++) {
            const dataOcorrenciaISO = addDiasISO(dataInicioISO, i * intervalo * 7);

            if (!cicloFim || dataOcorrenciaISO > cicloFim) {
              cicloInicio = dataOcorrenciaISO;
              cicloFim = addDiasISO(dataOcorrenciaISO, 30);
              saldo = saldoInicial(cliente.plano, cliente.subtipo_essencial);
              semanaIndex = 0;
            }

            const chaves = padrao[semanaIndex % padrao.length];
            const pacoteUsado = {};
            for (const chave of chaves) {
              const campo = campoSaldo(chave);
              if (!campo) continue;
              if (campo === 'sobrancelha_restante') {
                if (saldo[campo]) { saldo[campo] = false; pacoteUsado[campo] = true; }
              } else if (saldo[campo] > 0) {
                saldo[campo] -= 1;
                pacoteUsado[campo] = (pacoteUsado[campo] || 0) + 1;
              }
              // Sem saldo pra essa chave (ex: admin reduziu manualmente o saldo
              // depois): a ocorrência ainda é criada — só não entra no
              // pacoteUsado, e vira avulso na hora de marcar "Compareceu".
            }

            ocorrencias.push({
              dataISO: dataOcorrenciaISO,
              servicoTexto: chavesParaServicoTexto(chaves) || servico,
              pacoteUsado: Object.keys(pacoteUsado).length ? pacoteUsado : null,
            });
            semanaIndex++;
          }

          // Grava só o estado FINAL depois de simular todas as ocorrências —
          // uma escrita só, não uma por ocorrência.
          await dbClient.query(
            `UPDATE saldo_ciclo SET cortes_restantes = $1, barbas_restantes = $2,
             pezinhos_restantes = $3, sobrancelha_restante = $4 WHERE cliente_id = $5`,
            [saldo.cortes_restantes, saldo.barbas_restantes, saldo.pezinhos_restantes, saldo.sobrancelha_restante, cliente.id]
          );
          await dbClient.query(
            `UPDATE clientes SET data_inicio_ciclo = $1, data_fim_ciclo = $2 WHERE id = $3`,
            [cicloInicio, cicloFim, cliente.id]
          );
        }
      }

      await dbClient.query('COMMIT');
    } catch (err) {
      await dbClient.query('ROLLBACK');
      throw err;
    } finally {
      dbClient.release();
    }

    // ---- Passo 2: cria um evento SEPARADO por ocorrência (não é mais uma série
    // RRULE única) — é o único jeito de cada uma ter um "servico" diferente
    // gravado desde a criação, já que a Google não permite isso numa recorrência.
    const eventosCriados = [];
    for (const ocorrencia of ocorrencias) {
      const [ano, mes, dia] = ocorrencia.dataISO.split('-');
      const startUTC = new Date(Date.UTC(ano, mes - 1, dia, hora, minuto));
      const endUTC = new Date(startUTC.getTime() + duracaoMin * 60000);

      const event = {
        summary: `✂️ ${ocorrencia.servicoTexto} — ${nome} (fixo)`,
        description: `📱 WhatsApp: ${telefone}\n💈 Serviço: ${ocorrencia.servicoTexto}\n💰 Valor: ${preco || 'incluso no pacote'}\n⏱ Duração: ${duracao || '60 min'}\n🔁 Horário fixo`,
        location: ENDERECO,
        start: { dateTime: toISO(startUTC), timeZone: 'America/Sao_Paulo' },
        end: { dateTime: toISO(endUTC), timeZone: 'America/Sao_Paulo' },
        colorId: '5',
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
            servico: ocorrencia.servicoTexto,
            preco: preco || '',
            ...(barbeiro_id ? { barbeiro_id: String(barbeiro_id) } : {}),
            ...(ocorrencia.pacoteUsado ? { pacote_usado: JSON.stringify(ocorrencia.pacoteUsado) } : {}),
          },
        },
      };

      try {
        const response = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
        eventosCriados.push({ data: ocorrencia.dataISO, servico: ocorrencia.servicoTexto, eventId: response.data.id });
      } catch (err) {
        console.error('Erro ao criar ocorrência do horário fixo:', ocorrencia.dataISO, err.message);
        eventosCriados.push({ data: ocorrencia.dataISO, servico: ocorrencia.servicoTexto, erro: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      total_criados: eventosCriados.filter(e => e.eventId).length,
      eventos: eventosCriados,
    });
  } catch (err) {
    console.error('Erro ao criar horário fixo:', err.message);
    return res.status(500).json({ error: 'Erro ao criar horário fixo', details: err.message });
  }
};
