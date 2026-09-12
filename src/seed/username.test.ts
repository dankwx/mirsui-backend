import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizar, mutar, gerarUsername, gerarDisplayName, USERNAME_RE } from './username'

// rng determinístico (LCG) para o teste não oscilar.
function rngFixo(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('normalizar: hífen vira underscore, corta a 30, rejeita o que não cabe no regex', () => {
  assert.equal(normalizar('glass-eyes-lover'), 'glass_eyes_lover')
  assert.equal(normalizar('a'.repeat(40))?.length, 30)
  assert.equal(normalizar('ab'), null)
  assert.equal(normalizar('  Cauannn '), 'Cauannn')
  assert.equal(normalizar('ã'), null)
})

test('mutar: sempre diferente do original e sempre válido', () => {
  const rng = rngFixo(7)
  for (const base of ['Cauannn', 'KuromeJKLL', 'LOUIXZZ', 'abc', 'user_2001', 'x99']) {
    for (let i = 0; i < 50; i++) {
      const m = mutar(base, rng)
      assert.ok(m, `mutar(${base}) devolveu null`)
      assert.notEqual(m, base)
      assert.match(m, USERNAME_RE)
    }
  }
})

test('gerarUsername: pula colisões e nunca devolve o handle original', async () => {
  const rng = rngFixo(3)
  const ocupados = new Set<string>()
  const primeiro = await gerarUsername('GlassEyesLover', async u => ocupados.has(u), { rng })
  assert.ok(primeiro)
  ocupados.add(primeiro)
  const segundo = await gerarUsername('GlassEyesLover', async u => ocupados.has(u), { rng })
  assert.ok(segundo)
  assert.notEqual(segundo, primeiro)
  assert.notEqual(segundo.toLowerCase(), 'glasseyeslover')
})

test('gerarUsername: handle inválido é descartado', async () => {
  assert.equal(await gerarUsername('ab', async () => false), null)
})

test('gerarDisplayName: separa palavras ou repete o username', () => {
  assert.equal(gerarDisplayName('GlassEyesLover', 'GlassEyesLovver', () => 0.1), 'Glass Eyes Lover')
  assert.equal(gerarDisplayName('GlassEyesLover', 'GlassEyesLovver', () => 0.9), 'GlassEyesLovver')
  assert.equal(gerarDisplayName('glass_eyes', 'glass_eyess', () => 0.1), 'glass eyes')
  assert.equal(gerarDisplayName('cauannn', 'cauannn7', () => 0.1), 'cauannn7')
})
