import type { FastifyInstance } from 'fastify'
import { supabase } from '../lib/supabase'

/**
 * GET /landing — tudo que a home deslogada do app precisa, numa chamada.
 *
 * Espelha a home do site (mirsui-web: app/(public)/page.tsx), que monta os
 * mesmos três blocos no servidor com utils/homeService.ts e
 * utils/homepageService.ts:
 *
 *   generos  → "Saia do repeat.": as fileiras por gênero do acervo
 *   achados  → "Música boa circula.": os salvamentos mais recentes
 *   pessoas  → a pilha de avatares de quem já está aqui
 *
 * As regras (gêneros da casa, embaralhamento estável, paginação da contagem)
 * são as do site. Se mudarem lá, mudam aqui — a home do app tem que contar a
 * mesma história com os mesmos números.
 *
 * Cada bloco falha sozinho: devolve lista vazia e registra no log, como o site
 * faz. A home ainda converte sem a cena, e um 500 aqui derrubaria o acervo
 * junto com ela.
 */

const UM_MINUTO = 60 * 1000
const UMA_HORA = 60 * UM_MINUTO

/** Mesmo corte da home do site: seis gêneros, seis capas cada. */
const QUANTOS_GENEROS = 6
const CAPAS_POR_GENERO = 6
const QUANTOS_ACHADOS = 4
const QUANTAS_PESSOAS = 4

/**
 * Os gêneros da home, na ordem em que aparecem. Escolha editorial, igual à do
 * site: o Observatório semeia o catálogo de forma quase uniforme, então ordenar
 * por volume traria música infantil e trilha de jogo para o topo.
 */
const GENEROS_DA_CASA = [
  'MPB',
  'Rap/Funk Brasileiro',
  'Samba/Pagode',
  'Alternativo',
  'Rap/Hip Hop',
  'Electro',
  'Rock',
  'Soul & Funk'
]

/** Capa do Deezer em 250px, o tamanho que o grid do site pede. */
const capaDoAcervo = (md5: string | null) =>
  md5 ? `https://cdn-images.dzcdn.net/images/cover/${md5}/250x250-000000-80-0-0.jpg` : null

export interface FaixaDoGenero {
  isrc: string | null
  titulo: string
  artista: string
  capa: string | null
}

export interface GeneroDaLanding {
  nome: string
  /** faixas ativas deste gênero no acervo inteiro, não só a amostra */
  total: number
  faixas: FaixaDoGenero[]
}

export interface AchadoDaLanding {
  id: number
  track_title: string
  artist_name: string
  track_thumbnail: string | null
  position: number
  claimedat: string | null
  claim_message: string | null
  track_uri: string | null
  isrc: string | null
  username: string
  display_name: string | null
  avatar_url: string | null
}

export interface PessoaDaLanding {
  username: string
  nome: string
  avatar: string | null
  faixas: number
  primeiros: number
}

interface LinhaDoAcervo {
  title: string | null
  artist_name: string | null
  cover_md5: string | null
  isrc: string | null
}

/**
 * Embaralha sempre igual para a mesma semente — a mesma função do site, com a
 * mesma semente, para as capas de cada gênero saírem na mesma ordem nos dois.
 */
function embaralharEstavel<T>(lista: T[], semente: number): T[] {
  const saida = lista.slice()
  let s = semente
  const proximo = () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
  for (let i = saida.length - 1; i > 0; i--) {
    const j = Math.floor(proximo() * (i + 1))
    ;[saida[i], saida[j]] = [saida[j], saida[i]]
  }
  return saida
}

/**
 * Cache em memória com validade e deduplicação de voo.
 *
 * O site usa o unstable_cache do Next; aqui é o equivalente mínimo. Enquanto
 * uma busca está no ar, quem chega espera a mesma promessa em vez de disparar
 * outra varredura do acervo.
 */
function cacheado<T>(validade: number, buscar: () => Promise<T>) {
  let valor: { dado: T; ate: number } | null = null
  let emVoo: Promise<T> | null = null

  return (): Promise<T> => {
    if (valor && valor.ate > Date.now()) return Promise.resolve(valor.dado)
    if (emVoo) return emVoo
    emVoo = buscar()
      .then((dado) => {
        valor = { dado, ate: Date.now() + validade }
        return dado
      })
      .finally(() => {
        emVoo = null
      })
    return emVoo
  }
}

export default async function landingRoutes(app: FastifyInstance) {
  /**
   * Contagem por gênero do acervo inteiro, paginada: o PostgREST corta em mil
   * linhas e o acervo tem milhares. Sem paginar, a contagem sai errada calada.
   * Ordem explícita pela PK, para páginas não repetirem nem pularem linha.
   */
  async function contarGeneros(): Promise<Map<string, number> | null> {
    const PAGINA = 1000
    const totais = new Map<string, number>()
    for (let de = 0; ; de += PAGINA) {
      const { data, error } = await supabase
        .from('observed_tracks')
        .select('genre')
        .eq('active', true)
        .not('genre', 'is', null)
        .order('deezer_track_id', { ascending: true })
        .range(de, de + PAGINA - 1)

      if (error) {
        app.log.error({ err: error }, '[landing] falha na contagem de gêneros')
        return null
      }
      const pagina = (data ?? []) as { genre: string }[]
      for (const l of pagina) totais.set(l.genre, (totais.get(l.genre) ?? 0) + 1)
      if (pagina.length < PAGINA) break
    }
    return totais
  }

  const generos = cacheado(UMA_HORA, async (): Promise<GeneroDaLanding[]> => {
    const totais = await contarGeneros()
    if (!totais) return []

    const fileiras = await Promise.all(
      GENEROS_DA_CASA.slice(0, QUANTOS_GENEROS).map(async (nome) => {
        const { data, error } = await supabase
          .from('observed_tracks')
          .select('title,artist_name,cover_md5,isrc')
          .eq('active', true)
          .eq('genre', nome)
          .not('cover_md5', 'is', null)
          .limit(CAPAS_POR_GENERO * 4)

        if (error) {
          app.log.error({ err: error }, `[landing] falha nas capas de ${nome}`)
          return null
        }
        const faixas = embaralharEstavel((data ?? []) as LinhaDoAcervo[], 981)
          .slice(0, CAPAS_POR_GENERO)
          .map((l) => ({
            isrc: l.isrc,
            titulo: l.title ?? '',
            artista: l.artist_name ?? '',
            capa: capaDoAcervo(l.cover_md5)
          }))

        // Fileira incompleta sai, como no site: um gênero com duas capas num
        // grid de seis parece quebrado, não pequeno.
        if (faixas.length < CAPAS_POR_GENERO) return null
        return { nome, total: totais.get(nome) ?? faixas.length, faixas }
      })
    )

    return fileiras.filter((f): f is GeneroDaLanding => f !== null)
  })

  const achados = cacheado(UM_MINUTO, async (): Promise<AchadoDaLanding[]> => {
    const { data, error } = await supabase
      .from('tracks')
      .select(`
        id,
        track_title,
        artist_name,
        track_thumbnail,
        position,
        claimedat,
        claim_message,
        track_uri,
        isrc,
        profiles:user_id!inner (
          username,
          display_name,
          avatar_url
        )
      `)
      .not('claimedat', 'is', null)
      .order('claimedat', { ascending: false })
      .limit(QUANTOS_ACHADOS)

    if (error) {
      app.log.error({ err: error }, '[landing] falha nos achados recentes')
      return []
    }

    return (data ?? []).map((t: any) => {
      const p = Array.isArray(t.profiles) ? t.profiles[0] : t.profiles
      return {
        id: t.id,
        track_title: t.track_title,
        artist_name: t.artist_name,
        track_thumbnail: t.track_thumbnail,
        position: t.position,
        claimedat: t.claimedat,
        claim_message: t.claim_message,
        track_uri: t.track_uri,
        isrc: t.isrc ?? null,
        username: p?.username || '',
        display_name: p?.display_name || null,
        avatar_url: p?.avatar_url || null
      }
    })
  })

  const pessoas = cacheado(UMA_HORA, async (): Promise<PessoaDaLanding[]> => {
    const { data, error } = await supabase
      .from('tracks')
      .select('user_id,position,profiles:user_id!inner(username,display_name,avatar_url)')
      .not('claimedat', 'is', null)

    if (error) {
      app.log.error({ err: error }, '[landing] falha nas pessoas da cena')
      return []
    }

    const mapa = new Map<string, PessoaDaLanding>()
    for (const l of (data ?? []) as any[]) {
      const p = Array.isArray(l.profiles) ? l.profiles[0] : l.profiles
      if (!p?.username) continue
      const atual = mapa.get(p.username) ?? {
        username: p.username,
        nome: p.display_name || p.username,
        avatar: p.avatar_url ?? null,
        faixas: 0,
        primeiros: 0
      }
      atual.faixas++
      if (l.position === 1) atual.primeiros++
      mapa.set(p.username, atual)
    }

    return Array.from(mapa.values())
      .sort((a, b) => b.faixas - a.faixas || b.primeiros - a.primeiros)
      .slice(0, QUANTAS_PESSOAS)
  })

  app.get('/landing', async (request, reply) => {
    const [g, a, p] = await Promise.all([generos(), achados(), pessoas()])
    return reply.send({ generos: g, achados: a, pessoas: p })
  })
}
