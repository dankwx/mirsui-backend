import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortearDataDeEntrada, sortearSeguidos, embaralhar, ABERTURA, JANELA_DE_ENTRADA_DIAS } from './lote'

function rngFixo(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const DIA = 24 * 60 * 60 * 1000

test('sortearDataDeEntrada: entre agora-180d e ontem; logo após a abertura, nunca antes dela', () => {
  const rng = rngFixo(5)
  const agora = new Date('2026-09-12T15:00:00Z')
  const inicio = agora.getTime() - JANELA_DE_ENTRADA_DIAS * DIA
  const ontem = agora.getTime() - DIA
  const vistos = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const d = sortearDataDeEntrada(agora, rng)
    assert.ok(d.getTime() >= inicio && d.getTime() < ontem, d.toISOString())
    vistos.add(d.toISOString().slice(0, 10))
  }
  assert.ok(vistos.size > 100, 'as datas se espalham por muitos dias')

  const cedo = new Date('2024-06-10T00:00:00Z')
  for (let i = 0; i < 100; i++) {
    const d = sortearDataDeEntrada(cedo, rng)
    assert.ok(d >= ABERTURA && d.getTime() < cedo.getTime() - DIA + 1)
  }
  // no dia seguinte à abertura só cabe "ontem"
  const diaSeguinte = new Date('2024-06-02T00:00:00Z')
  assert.equal(sortearDataDeEntrada(diaSeguinte, rng).getTime(), ABERTURA.getTime())
})

test('sortearSeguidos: 0–4, nunca a si mesmo, sem repetição, limitado ao que existe', () => {
  const rng = rngFixo(8)
  const todos = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const contagem = new Map<number, number>()
  for (let i = 0; i < 500; i++) {
    const s = sortearSeguidos('c', todos, rng)
    assert.ok(s.length <= 4)
    assert.ok(!s.includes('c'))
    assert.equal(new Set(s).size, s.length)
    for (const id of s) assert.ok(todos.includes(id))
    contagem.set(s.length, (contagem.get(s.length) ?? 0) + 1)
  }
  for (let n = 0; n <= 4; n++) assert.ok((contagem.get(n) ?? 0) > 50, `n=${n}`)

  assert.deepEqual(sortearSeguidos('x', ['x'], rng), [])
  assert.ok(sortearSeguidos('x', ['x', 'y'], () => 0.99).length === 1)
})

test('embaralhar: mesma coleção, outra ordem, original intacto', () => {
  const original = [1, 2, 3, 4, 5, 6, 7, 8]
  const copia = embaralhar(original, rngFixo(1))
  assert.deepEqual([...copia].sort(), original)
  assert.notDeepEqual(copia, original)
  assert.deepEqual(original, [1, 2, 3, 4, 5, 6, 7, 8])
})
