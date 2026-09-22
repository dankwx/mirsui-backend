import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import {
  radioDoArtista,
  relacionadosDoArtista,
  albunsDoArtista,
  buscarFaixa,
  faixasDoAlbum,
  fichaDoAlbum,
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
process.env.DEEZER_GATEWAY_TOKEN = 'test-token-not-a-real-credential'

const responderCom = (corpo: unknown, ok = true) => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify((corpo as { error?: { code?: number } })?.error?.code === 4
      ? { ok: false, status: 429, reason: 'upstream', retryAfterMs: 0 }
      : { ok: true, data: corpo, fetchedAt: Date.now(), cached: false }), {
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

// Campos fixos (migration 037): a página de faixa lê do banco o que antes
// pedia ao Deezer a cada visita. O que o endpoint não traz tem que chegar como
// null — "não disse" — e nunca como um palpite que o banco gravaria por cima.

test('/track traz os campos fixos inteiros, e a prévia só como "existe"', async () => {
  responderCom({
    id: 3135556, title: 'Harder, Better, Faster, Stronger', rank: 800000,
    isrc: 'GBDUW0000059', duration: 224, explicit_lyrics: false,
    preview: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/abc.mp3?hdnea=exp=1',
    release_date: '2001-03-12',
    contributors: [{ id: 27, name: 'Daft Punk' }, { id: 99, name: 'Convidada' }],
    artist: { id: 27, name: 'Daft Punk' }, album: { id: 302127, title: 'Discovery' },
  })
  const { faixa } = await buscarFaixa('3135556')
  assert.equal(faixa?.duration_seconds, 224)
  assert.equal(faixa?.explicit_lyrics, false)
  assert.equal(faixa?.has_preview, true)
  assert.equal(faixa?.release_date, '2001-03-12')
  assert.deepEqual(faixa?.contributors, [
    { id: '27', name: 'Daft Punk' },
    { id: '99', name: 'Convidada' },
  ])
  assert.ok(!JSON.stringify(faixa).includes('hdnea'), 'a URL assinada nunca vai para o banco')
})

test('faixa de álbum não inventa data nem participações', async () => {
  responderCom({
    data: [
      { id: 1, title: 'A', rank: 10, isrc: 'X1', duration: 200, explicit_lyrics: true, preview: '' },
      { id: 2, title: 'B', rank: 20, isrc: 'X2' },
    ],
    total: 2,
  })
  const r = await faixasDoAlbum('10')
  assert.equal(r.falhou, false)
  const [a, b] = r.faixas
  assert.equal(a.duration_seconds, 200)
  assert.equal(a.explicit_lyrics, true)
  assert.equal(a.has_preview, false, 'preview vazio é "sem prévia"')
  assert.equal(a.release_date, null)
  assert.equal(a.contributors, null)
  assert.equal(b.explicit_lyrics, null, 'campo ausente não é "não explícito"')
  assert.equal(b.has_preview, null, 'campo ausente não é "sem prévia"')
  assert.equal(b.duration_seconds, null)
})

test('data inválida do Deezer vira null antes de chegar ao banco', async () => {
  responderCom({ data: [
    { id: 1, title: 'X', release_date: '0000-00-00', record_type: 'album' },
    { id: 2, title: 'Y', release_date: '2001-02-30', record_type: 'album' },
    { id: 3, title: 'Z', release_date: '2019-11-01', record_type: 'single' },
  ], total: 3 })
  const r = await albunsDoArtista('27')
  assert.deepEqual(r.albuns.map((a) => a.release_date), [null, null, '2019-11-01'])
})

test('a ficha do álbum traz o primeiro gênero e a data; 800 é resposta, não falha', async () => {
  responderCom({ id: 302127, title: 'Discovery', release_date: '2001-03-07',
    genres: { data: [{ id: 113, name: 'Dance' }, { id: 106, name: 'Electro' }] } })
  assert.deepEqual(await fichaDoAlbum('302127'),
    { genero: 'Dance', release_date: '2001-03-07', falhou: false })

  responderCom(SEM_DADOS)
  assert.deepEqual(await fichaDoAlbum('1'), { genero: null, release_date: null, falhou: false })

  responderCom(QUOTA)
  assert.equal((await fichaDoAlbum('1')).falhou, true, 'quota volta amanhã')
})

test('a discografia traz o id do gênero; -1 e 0 são "sem gênero"', async () => {
  responderCom({ data: [
    { id: 1, title: 'X', genre_id: 106 },
    { id: 2, title: 'Y', genre_id: -1 },
    { id: 3, title: 'Z', genre_id: 0 },
  ], total: 3 })
  const r = await albunsDoArtista('27')
  assert.deepEqual(r.albuns.map((a) => a.genre_id), [106, null, null])
})
