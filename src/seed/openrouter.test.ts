import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortearBrief, montarPrompt, interpretarResposta, casa, gerarGostoMusical, BIO_MAX, MEMORIA_DE_FAIXAS } from './openrouter'
import type { FaixaDaBusca } from '../lib/deezer'

function rngFixo(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

test('sortearBrief: gêneros distintos, 1–2 traços de eixos diferentes, bio ausente em parte dos perfis', () => {
  const rng = rngFixo(11)
  let semBio = 0
  const eixosVistos = new Set<string>()
  for (let i = 0; i < 300; i++) {
    const b = sortearBrief(rng)
    assert.notEqual(b.generos[0], b.generos[1])
    assert.ok(b.tracos.length >= 1 && b.tracos.length <= 2)
    assert.ok([1, 2, 3].includes(b.quantidade))
    if (b.bioEstilo === null) semBio++
    for (const t of b.tracos) eixosVistos.add(t.split(' ')[0])
  }
  assert.ok(semBio > 60 && semBio < 180, `semBio=${semBio}`)
  // "é de <signo>", "é INTP", "tem N anos", "mora em", "ouve", "descobre"… — mais de um eixo aparece.
  assert.ok(eixosVistos.size >= 4)
})

test('montarPrompt: só pede bio quando há estilo, e a memória entra cortada', () => {
  const rng = rngFixo(2)
  const brief = { ...sortearBrief(rng), bioEstilo: null }
  const memoria = Array.from({ length: 100 }, (_, i) => `Artista ${i} – Faixa ${i}`)
  const p = montarPrompt(brief, memoria)
  assert.ok(!p.includes('Bio do perfil'))
  assert.ok(!p.includes('"bio"'))
  assert.ok(!p.includes('Faixa 0 '), 'a mais antiga foi cortada')
  assert.ok(p.includes(`Faixa ${100 - MEMORIA_DE_FAIXAS}`))
  assert.ok(p.includes('Faixa 99'))

  const comBio = montarPrompt({ ...brief, bioEstilo: 'uma palavra só' }, [])
  assert.ok(comBio.includes('uma palavra só'))
  assert.ok(comBio.includes('NÃO tem nenhuma relação'))
  assert.ok(!comBio.includes('Não escolha'))
})

test('interpretarResposta: tolera cerca e lixo, descarta faixa incompleta, limpa a bio', () => {
  const r = interpretarResposta('claro!\n```json\n{"tracks":[{"artist":"Mitski","title":"Nobody"},{"artist":"","title":"x"},{"title":"sem artista"}],"bio":"  oi  #tag  "}\n```')
  assert.deepEqual(r.tracks, [{ artist: 'Mitski', title: 'Nobody' }])
  assert.equal(r.bio, 'oi')

  assert.deepEqual(interpretarResposta('não sei'), { tracks: [], bio: null })
  assert.deepEqual(interpretarResposta('{"tracks": "x", "bio": 3}'), { tracks: [], bio: null })
  assert.equal(interpretarResposta('{"bio":""}').bio, null)
  assert.equal(interpretarResposta(`{"bio":"${'a'.repeat(500)}"}`).bio?.length, BIO_MAX)
})

function faixa(artist: string, title: string): FaixaDaBusca {
  return {
    id: 'x', title, artist, uri: 'deezer:track:1', isrc: null, deezerTrackId: '1', deezerArtistId: null,
    deezerAlbumId: null, albumName: null, duration: 0, explicit: false, releaseDate: null,
    thumbnail: null, cover: null, preview: null, rank: 0
  }
}

test('casa: aceita quando artista ou título compartilham palavra, ignorando acento e caixa', () => {
  assert.ok(casa({ artist: 'Marília Mendonça', title: 'Infiel' }, faixa('Marilia Mendonca', 'Infiel (Ao Vivo)')))
  assert.ok(casa({ artist: 'Tim Bernardes', title: 'Mistificar' }, faixa('Tim Bernardes, Fernanda Takai', 'Outra coisa')))
  assert.ok(!casa({ artist: 'Mitski', title: 'Nobody' }, faixa('Ana Carolina', 'Quem de nós dois')))
  assert.ok(!casa({ artist: 'BK', title: 'Ok' }, faixa('Anitta', 'Envolver')), 'palavras curtas não contam')
})

test('gerarGostoMusical: monta a chamada, refaz sem response_format em 400, devolve uso', async () => {
  const chamadas: { body: Record<string, unknown>; auth: string | null }[] = []
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    chamadas.push({ body, auth: (init?.headers as Record<string, string>).Authorization })
    if (body.response_format) return new Response('modelo não suporta', { status: 400 })
    return Response.json({
      choices: [{ message: { content: '{"tracks":[{"artist":"Boogarins","title":"Lucifernandis"}],"bio":"kkkk"}' } }],
      usage: { prompt_tokens: 120, completion_tokens: 30 }
    })
  }) as typeof fetch

  const brief = { ...sortearBrief(rngFixo(5)), bioEstilo: null }
  const r = await gerarGostoMusical(['A – B'], { brief, apiKey: 'k', model: 'm', fetchImpl })
  assert.equal(chamadas.length, 2)
  assert.equal(chamadas[0].auth, 'Bearer k')
  assert.equal(chamadas[1].body.model, 'm')
  assert.equal(chamadas[1].body.response_format, undefined)
  assert.deepEqual(r.tracks, [{ artist: 'Boogarins', title: 'Lucifernandis' }])
  assert.equal(r.bio, null, 'sem estilo sorteado a bio é descartada mesmo que o modelo mande')
  assert.deepEqual(r.uso, { prompt_tokens: 120, completion_tokens: 30 })

  await assert.rejects(gerarGostoMusical([], { brief, apiKey: '', fetchImpl }), /OPENROUTER_API_KEY/)
})
