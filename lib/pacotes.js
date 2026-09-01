// Regras travadas dos pacotes (não alterar sem confirmação do David)
const PRECOS = {
  corte: 50,
  barba: 50,
  corte_barba: 95, // combo avulso
  corte_kids: 45,
  pezinho: 15,
  sobrancelha: 15,
};
function saldoInicial(plano, subtipoEssencial) {
  if (plano === 'essencial') {
    if (subtipoEssencial === 'corte') {
      return { cortes_restantes: 4, barbas_restantes: 0, pezinhos_restantes: 0, sobrancelha_restante: false };
    }
    if (subtipoEssencial === 'barba') {
      return { cortes_restantes: 0, barbas_restantes: 4, pezinhos_restantes: 0, sobrancelha_restante: false };
    }
    throw new Error('Plano essencial exige subtipo_essencial: corte ou barba');
  }
  if (plano === 'classico') {
    return { cortes_restantes: 2, barbas_restantes: 4, pezinhos_restantes: 2, sobrancelha_restante: false };
  }
  if (plano === 'empresario') {
    return { cortes_restantes: 4, barbas_restantes: 4, pezinhos_restantes: 0, sobrancelha_restante: true };
  }
  // nenhum
  return { cortes_restantes: 0, barbas_restantes: 0, pezinhos_restantes: 0, sobrancelha_restante: false };
}
function campoSaldo(servico) {
  const map = {
    corte: 'cortes_restantes',
    barba: 'barbas_restantes',
    pezinho: 'pezinhos_restantes',
    sobrancelha: 'sobrancelha_restante',
  };
  return map[servico];
}

// ---- Adicionado: reaproveitado por api/agenda-hoje.js (registro definitivo no
// "Compareceu") e espelha a lógica que já existia solta em api/atendimentos.js ----

// Interpreta o texto de serviço gravado no agendamento (private.servico do evento
// do Calendar, ex: "Corte + Barba", "Corte Kids", "Sobrancelha") e devolve as
// chaves internas correspondentes. "Corte Kids" NUNCA é decomposto nem coberto
// por pacote — sempre avulso, com preço próprio.
function normalizarServicos(servicoStr) {
  if ((servicoStr || '').trim() === 'Corte Kids') return ['corte_kids'];
  const MAPA = { Corte: 'corte', Barba: 'barba', Pezinho: 'pezinho', Sobrancelha: 'sobrancelha' };
  return (servicoStr || '').split(' + ').map(s => MAPA[s.trim()]).filter(Boolean);
}

// Calcula o valor avulso de uma lista de chaves de serviço, aplicando o combo
// Corte+Barba quando os dois aparecem juntos (mesma regra de api/atendimentos.js).
function precoAvulso(chaves) {
  const set = new Set(chaves);
  let total = 0;
  if (set.has('corte') && set.has('barba')) {
    total += PRECOS.corte_barba;
    set.delete('corte');
    set.delete('barba');
  }
  for (const chave of set) {
    total += PRECOS[chave] || 0;
  }
  return total;
}

// ---- Padrão semanal de consumo por plano ----
// Define, pra cada plano, o que entra em CADA uma das 4 visitas semanais de um
// ciclo (30 dias ≈ 4 semanas) — pra bater exatamente com as quantidades de
// saldoInicial() acima. Regra: o serviço com a quantidade cheia (igual ao nº
// de semanas) entra TODA semana; serviços com metade da quantidade se
// revezam em semanas alternadas. Isso é o que api/agendar-fixo.js usa pra
// montar a recorrência automática em vez de repetir sempre o mesmo serviço.
// Sobrancelha (brinde único do empresário) fica de fora — não é semanal, é
// consumida por fora quando o cliente pedir, uma vez por ciclo.
function padraoSemanalPacote(plano, subtipoEssencial) {
  if (plano === 'essencial') {
    if (subtipoEssencial === 'corte') return [['corte'], ['corte'], ['corte'], ['corte']];
    if (subtipoEssencial === 'barba') return [['barba'], ['barba'], ['barba'], ['barba']];
    return null;
  }
  if (plano === 'classico') {
    // barba: cheia (toda semana) — corte e pezinho se revezam
    return [['corte', 'barba'], ['barba', 'pezinho'], ['corte', 'barba'], ['barba', 'pezinho']];
  }
  if (plano === 'empresario') {
    // corte e barba: ambos cheios — toda semana os dois
    return [['corte', 'barba'], ['corte', 'barba'], ['corte', 'barba'], ['corte', 'barba']];
  }
  return null; // sem plano — sem padrão, o admin escolhe o serviço manualmente
}

// Converte um array de chaves (ex: ['corte','barba']) pro texto que o resto do
// sistema usa em toda parte (agendar.js grava isso em private.servico,
// agenda-hoje.js interpreta de volta) — ex: "Corte + Barba". Ordem sempre
// fixa: corte, barba, pezinho, sobrancelha.
function chavesParaServicoTexto(chaves) {
  const LABEL = { corte: 'Corte', barba: 'Barba', pezinho: 'Pezinho', sobrancelha: 'Sobrancelha' };
  const ORDEM = ['corte', 'barba', 'pezinho', 'sobrancelha'];
  return ORDEM.filter(k => chaves.includes(k)).map(k => LABEL[k]).join(' + ');
}

module.exports = {
  PRECOS, saldoInicial, campoSaldo, normalizarServicos, precoAvulso,
  padraoSemanalPacote, chavesParaServicoTexto,
};
