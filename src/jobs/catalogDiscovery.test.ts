import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calcularOrcamentoDescoberta,
  type ConfigDescoberta,
} from './catalogDiscovery'

const config: ConfigDescoberta = {
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
