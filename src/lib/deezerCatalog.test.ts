import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  radioDoArtista,
  relacionadosDoArtista,
  albunsDoArtista,
} from './deezerCatalog'

// "não tem" contra "não consegui perguntar"
//
// O Deezer responde HTTP 200 com `{"error":{"code":800,"message":"no data"}}`
// quando o recurso existe mas está vazio — artista pequeno demais para ter
// rádio, por exemplo. Medido em 16/08/2026: 10 de 12 sementes da fila real
// devolvem 800 em /artist/{id}/radio.
//
// Se isso for lido como falha transitória, a semente nunca recebe
// `recommendation_checked_at` e volta à fila TODA NOITE, para sempre, falhando
// sempre. A fila entope de sementes impossíveis e nada no log diz isso. Estes
// testes existem para essa distinção não se perder numa refatoração.

const fetchOriginal = globalThis.fetch

const responderCom = (corpo: unknown, ok = true) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(corpo), {
      status: ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch
}

afterEach(() => {
  globalThis.fetch = fetchOriginal
})

const SEM_DADOS = { error: { type: 'DataException', message: 'no data', code: 800 } }
const QUOTA = { error: { type: 'Exception', message: 'Quota limit exceeded', code: 4 } }

test('artista sem rádio é resposta vazia, não falha', async () => {
  responderCom(SEM_DADOS)
  const r = await radioDoArtista('303669951')
  assert.equal(r.falhou, false, 'code 800 não pode marcar falha')
  assert.deepEqual(r.faixas, [])
})

test('artista sem relacionados é resposta vazia, não falha', async () => {
  responderCom(SEM_DADOS)
  const r = await relacionadosDoArtista('303669951')
  assert.equal(r.falhou, false)
  assert.deepEqual(r.artistas, [])
})

test('artista sem álbuns é discografia vazia, não falha', async () => {
  responderCom(SEM_DADOS)
  const r = await albunsDoArtista('303669951')
  assert.equal(r.falhou, false)
  assert.equal(r.total, 0)
  assert.deepEqual(r.albuns, [])
})

test('falha de verdade continua sendo falha — a semente precisa voltar amanhã', async () => {
  // Quota estourada é transitória: marcar a semente aqui perderia a faixa para
  // sempre por causa de um pico de tráfego.
  responderCom(QUOTA)
  assert.equal((await radioDoArtista('27')).falhou, true)
  assert.equal((await relacionadosDoArtista('27')).falhou, true)
  assert.equal((await albunsDoArtista('27')).falhou, true)
})

test('resposta ilegível também é falha, não vazio', async () => {
  responderCom({ isso: 'não é uma lista' })
  assert.equal((await radioDoArtista('27')).falhou, true)
  assert.equal((await relacionadosDoArtista('27')).falhou, true)
  assert.equal((await albunsDoArtista('27')).falhou, true)
})

test('lista vazia sem erro nenhum já era resposta válida', async () => {
  // /artist/{id}/related devolve data[] em vez de 800 para alguns artistas.
  // Medido: 7 de 12 sementes reais respondem assim.
  responderCom({ data: [] })
  const r = await relacionadosDoArtista('354541232')
  assert.equal(r.falhou, false)
  assert.deepEqual(r.artistas, [])
})
