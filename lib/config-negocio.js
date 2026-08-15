// ============================================================
// CONFIG DO NEGÓCIO (backend) — única fonte de verdade dos
// preços e regras de pacote usados pelo backend-v2.
//
// Espelha o config-negocio.js do frontend (App-Agenda). Se
// mudar um preço ou uma regra de pacote, mude aqui E lá pra
// manter os dois sincronizados — o backend não lê o arquivo
// do frontend (são projetos/deploys separados na Vercel).
// ============================================================

// Preços por serviço avulso (usado em agendar.js, comandas, etc.)
const PRECOS_SERVICOS = {
  corte: 50,
  barba: 50,
  corte_barba: 95, // combo avulso
  corte_kids: 45,
  pezinho: 15,
  sobrancelha: 15,
};

// Valor mensal de cada plano
const VALOR_PLANO = {
  essencial: 160,
  classico: 260,
  empresario: 340,
};

// Saldo inicial de cada plano ao ser contratado (e subtipo, no caso do essencial)
const SALDO_INICIAL_PLANO = {
  essencial: {
    corte: { cortes_restantes: 4, barbas_restantes: 0, pezinhos_restantes: 0, sobrancelha_restante: false },
    barba: { cortes_restantes: 0, barbas_restantes: 4, pezinhos_restantes: 0, sobrancelha_restante: false },
  },
  classico: { cortes_restantes: 2, barbas_restantes: 4, pezinhos_restantes: 2, sobrancelha_restante: false },
  empresario: { cortes_restantes: 4, barbas_restantes: 4, pezinhos_restantes: 0, sobrancelha_restante: true },
  nenhum: { cortes_restantes: 0, barbas_restantes: 0, pezinhos_restantes: 0, sobrancelha_restante: false },
};

// Dados fixos usados na criação de eventos do Google Calendar e nas notificações push.
// Podem ser sobrescritos por env var na Vercel quando fizer sentido (ex: CALENDAR_ID
// já é lido de env var nos arquivos que usam ISSO como valor padrão de fallback).
const NOME = 'Barbearia do Deeh'; // título usado nas notificações push
const ENDERECO = 'Rua Seraphin Gilberto Candelo, 2063 – Jd. Morada do Sol';
const WHATSAPP_ADMIN = '5519993900880'; // identificador do dono nas push_subscriptions
const CALENDAR_ID_PADRAO = 'davidlucas261210@gmail.com'; // fallback se a env var CALENDAR_ID não estiver setada
const VAPID_SUBJECT_PADRAO = 'mailto:contato@barbeariadodeeh.com'; // fallback se a env var VAPID_SUBJECT não estiver setada

module.exports = {
  PRECOS_SERVICOS,
  VALOR_PLANO,
  SALDO_INICIAL_PLANO,
  NOME,
  ENDERECO,
  WHATSAPP_ADMIN,
  CALENDAR_ID_PADRAO,
  VAPID_SUBJECT_PADRAO,
};
