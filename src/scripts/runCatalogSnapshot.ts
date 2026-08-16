// src/scripts/runCatalogSnapshot.ts
// Roda o Observatório uma vez, na mão, sem subir o servidor:
//
//   npm run observatorio
//
// Serve para a primeira rodada (semear o catálogo sem esperar as 05:00) e para
// conferir depois de mexer no job. É idempotente por dia: rodar de novo hoje
// atualiza o rank medido, mas não cria um segundo ponto no histórico.
//
// Por padrão a rodada não tem teto: varre o catálogo até acabar. Para um teste
// rápido, as envs abaixo cortam cada etapa (0 desliga a etapa), ex.:
//   OBS_MAX_GENEROS=2 OBS_LIMITE_MEDICAO=0 OBS_LIMITE_ACERVO=0 npm run observatorio

import { runCatalogSnapshot } from '../jobs/catalogSnapshot'

const resultado = await runCatalogSnapshot()

console.log('\nObservatório — resumo da rodada')
console.log('  pontos gravados no histórico :', resultado.pontos)
console.log('  faixas vindas de chart       :', resultado.doChart)
console.log('  faixas vindas do acervo      :', resultado.doAcervo)
console.log('  medidas uma a uma            :', resultado.medidasIndividuais)
console.log('  ISRC preenchidos             :', resultado.isrcPreenchidos)
console.log('    - por album (1 req / album):', resultado.isrcResolvidosPorAlbum)
console.log('    - um a um  (1 req / faixa) :', resultado.isrcResolvidosUmAUm)
console.log('    - requisicoes de album     :', resultado.isrcRequisicoesDeAlbum)
console.log('  sementes de descoberta       :', resultado.descobertaSementes)
console.log('  novas faixas semelhantes     :', resultado.descobertaNovas)
console.log('  sementes sem candidata       :', resultado.descobertaSemCandidata)
console.log('  falhas de API na descoberta  :', resultado.descobertaFalhasApi)
console.log('  desativadas (saíram do Deezer):', resultado.desativadas)
console.log('  etapas com falha             :', resultado.falhas)

process.exit(resultado.falhas > 0 ? 1 : 0)
