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

module.exports = { PRECOS, saldoInicial, campoSaldo };
