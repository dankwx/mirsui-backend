import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calcularOrcamentoDescoberta,
  configDescobertaDoAmbiente,
  CONFIG_DESCOBERTA_PADRAO,
  type ConfigDescoberta,
} from './catalogDiscovery'

const config: ConfigDescoberta = {
  ...CONFIG_DESCOBERTA_PADRAO,
  ativa: true,
  metaInicial: 6_604,
  limiteDiario: 250,
  maxCatalogo: 10_000,
}

test('a primeira rodada tenta completar a duplicação do catálogo inicial', () => {
  assert.equal(calcularOrcamentoDescoberta(3_302, config), 3_302)
  assert.equal(calcularOrcamentoDescoberta(6_500, config), 104)
})

test('depois da meta o crescimento diário fica linear', () => {
  assert.equal(calcularOrcamentoDescoberta(6_604, config), 250)
  assert.equal(calcularOrcamentoDescoberta(8_000, config), 250)
})

test('o teto absoluto reduz o último lote e depois bloqueia a expansão', () => {
  assert.equal(calcularOrcamentoDescoberta(9_900, config), 100)
  assert.equal(calcularOrcamentoDescoberta(10_000, config), 0)
  assert.equal(calcularOrcamentoDescoberta(10_500, config), 0)
})

test('a chave de desligamento prevalece sobre todas as metas', () => {
  assert.equal(calcularOrcamentoDescoberta(3_302, { ...config, ativa: false }), 0)
})

// --- corte entre as duas fontes de descoberta (ADR 002) --------------------
// O corte é o botão do experimento: 0 e 1 precisam desligar uma das fontes de
// verdade, e não cair no padrão. Um `if (!valor)` no lugar do teste de faixa
// faria `0` virar 0,7 silenciosamente — ou seja, ligaria a caminhada
// justamente na rodada em que alguém quis desligá-la.

const comEnv = <T>(chave: string, valor: string | undefined, fn: () => T): T => {
  const antes = process.env[chave]
  if (valor === undefined) delete process.env[chave]
  else process.env[chave] = valor
  try {
    return fn()
  } finally {
    if (antes === undefined) delete process.env[chave]
    else process.env[chave] = antes
  }
}

test('o corte entre álbum e rádio aceita os dois extremos', () => {
  assert.equal(
    comEnv('OBS_DESCOBERTA_SPLIT_ALBUM', '0', () => configDescobertaDoAmbiente().splitAlbum),
    0
  )
  assert.equal(
    comEnv('OBS_DESCOBERTA_SPLIT_ALBUM', '1', () => configDescobertaDoAmbiente().splitAlbum),
    1
  )
})

test('corte fora da faixa 0..1 cai no padrão em vez de distorcer o orçamento', () => {
  for (const bruto of ['1.5', '-0.2', 'abc', '']) {
    assert.equal(
      comEnv('OBS_DESCOBERTA_SPLIT_ALBUM', bruto, () => configDescobertaDoAmbiente().splitAlbum),
      CONFIG_DESCOBERTA_PADRAO.splitAlbum,
      `entrada ${JSON.stringify(bruto)} deveria cair no padrão`
    )
  }
})

test('o teto de fãs zero não é confundido com ausência de configuração', () => {
  // 0 é uma escolha legítima ("nenhum artista novo entra na fronteira"), e
  // precisa sobreviver ao parse — é o freio de mão da caminhada.
  assert.equal(
    comEnv('OBS_DESCOBERTA_MAX_FAS', '0', () => configDescobertaDoAmbiente().maxFas),
    0
  )
})

test('a sobra da caminhada volta para o rádio em vez de evaporar', () => {
  // O caso que motivou: a 026 não aplicada faz a caminhada falhar inteira. Sem
  // devolver, 70% do orçamento da noite some e o único sinal é uma linha de
  // erro no meio do log. Vale igual para fronteira vazia e para erro do Deezer.
  const devolver = (orcamento: number, split: number, novasDoAlbum: number) => {
    const albumAlvo = Math.round(orcamento * split)
    const sobra = Math.max(0, albumAlvo - novasDoAlbum)
    return orcamento - albumAlvo + sobra
  }

  assert.equal(devolver(1_000, 0.7, 0), 1_000, 'caminhada morta: rádio recebe tudo')
  assert.equal(devolver(1_000, 0.7, 700), 300, 'caminhada completa: rádio fica com o resto')
  assert.equal(devolver(1_000, 0.7, 400), 600, 'caminhada parcial: devolve o não gasto')
  // Colher MAIS que o alvo (o álbum vem inteiro) não pode roubar do rádio.
  assert.equal(devolver(1_000, 0.7, 900), 300, 'excedente não vira dívida do rádio')
})

test('o orçamento se divide entre as duas fontes sem sobrar nem faltar faixa', () => {
  // O rádio recebe o RESTO, e não uma segunda multiplicação: com split 0,7 e
  // orçamento 251, dois `Math.round` independentes dariam 176 + 75 = 251 por
  // sorte, mas 0,5 e 3 dariam 2 + 2 = 4. O resto garante a soma sempre.
  for (const orcamento of [1, 3, 250, 251, 999]) {
    for (const split of [0, 0.5, 0.7, 1]) {
      const album = Math.round(orcamento * split)
      const radio = orcamento - album
      assert.equal(album + radio, orcamento)
      assert.ok(album >= 0 && radio >= 0)
    }
  }
})
