// src/seed/openrouter.ts
// A IA dos perfis semeados: inventa o gosto musical de uma pessoa fictícia
// (1–3 faixas reais) e, às vezes, uma bio.
//
// Uma chamada por perfil ao OpenRouter (`OPENROUTER_API_KEY`, modelo em
// `OPENROUTER_MODEL`, padrão `tencent/hy4-preview` — escolhido por ser barato;
// o prompt é curto e o `max_tokens` é baixo de propósito).
//
// O problema de pedir "escolha 3 músicas" 50 vezes é que a IA escolhe
// "Blinding Lights" 50 vezes. Duas defesas:
//   1. cada chamada recebe um BRIEF sorteado aqui (não pela IA): dois gêneros,
//      uma década, um idioma, uma quantidade de faixas e um ou dois traços de
//      pessoa que mudam de eixo a cada perfil — ora é o signo, ora o MBTI, ora
//      a idade, a cidade, o que a pessoa faz, onde ela ouve música. O eixo
//      muda para a variação não ser só "outro signo".
//   2. a lista das últimas ~60 faixas já escolhidas neste lote vai no prompt
//      como "não repita".
//
// A bio é sorteada ANTES da chamada: ~40% dos perfis não têm bio e, nesses,
// o prompt nem pede uma (menos tokens). Quando pede, sorteia um ESTILO —
// frase de filme, inglês em minúsculas, erro de digitação, "kkkk", meme, só
// emoji, uma palavra, status de MSN… — e proíbe explicitamente que a bio fale
// de música, signo, personalidade ou de qualquer coisa do brief. A bio é a
// frase solta que a pessoa põe no Instagram, não um resumo do briefing.
//
// A resposta volta como JSON; a leitura é tolerante (cerca de ```json, texto
// antes/depois). As faixas são resolvidas no Deezer com `searchTracks(..., 1)`
// e passam por um casamento frouxo de artista/título — a IA erra nome de
// música, e a busca do Deezer devolve QUALQUER coisa para um texto errado.
// Faixa que não casa é pulada; perfil sem nenhuma faixa ainda é criado (gente
// sem ficha existe).

import { searchTracks, type FaixaDaBusca } from '../lib/deezer'
import type { Rng } from './username'

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'tencent/hy4-preview'

/** Quantas faixas já escolhidas entram no "não repita" do prompt. */
export const MEMORIA_DE_FAIXAS = 60
/** Fração dos perfis que NÃO ganham bio. */
export const FRACAO_SEM_BIO = 0.4
export const BIO_MAX = 160

// ---------------------------------------------------------------------------
// O brief

export const GENEROS = [
  'indie rock', 'MPB', 'trap', 'rap nacional', 'sertanejo', 'pagode', 'funk carioca', 'forró',
  'bossa nova', 'samba', 'pop', 'k-pop', 'r&b', 'soul', 'jazz', 'lo-fi', 'shoegaze', 'dream pop',
  'post-punk', 'emo', 'metal', 'hardcore', 'house', 'techno', 'drum and bass', 'reggaeton',
  'música latina', 'folk', 'country', 'synthpop', 'hyperpop', 'bedroom pop', 'rock brasileiro',
  'axé', 'brega', 'piseiro', 'gospel', 'trilha sonora de filme', 'música clássica', 'ambient'
] as const

export const DECADAS = ['anos 70', 'anos 80', 'anos 90', 'anos 2000', 'anos 2010', 'de 2020 pra cá', 'de qualquer época'] as const

export const IDIOMAS = [
  'português', 'português', 'português', 'inglês', 'inglês', 'espanhol', 'coreano', 'francês', 'japonês', 'qualquer idioma'
] as const

const SIGNOS = ['áries', 'touro', 'gêmeos', 'câncer', 'leão', 'virgem', 'libra', 'escorpião', 'sagitário', 'capricórnio', 'aquário', 'peixes']
const MBTI = ['INTP', 'INTJ', 'INFP', 'INFJ', 'ISTP', 'ISTJ', 'ISFP', 'ISFJ', 'ENTP', 'ENTJ', 'ENFP', 'ENFJ', 'ESTP', 'ESTJ', 'ESFP', 'ESFJ']
const CIDADES = [
  'São Paulo', 'Rio', 'BH', 'Recife', 'Salvador', 'Curitiba', 'Porto Alegre', 'Fortaleza', 'Goiânia', 'Manaus',
  'Campinas', 'Florianópolis', 'Belém', 'Brasília', 'uma cidade pequena do interior de Minas', 'Lisboa', 'Buenos Aires', 'Berlim'
]
const OCUPACOES = [
  'estuda medicina', 'trabalha em call center', 'é motoboy', 'faz design', 'está desempregado', 'dá aula de inglês',
  'é enfermeira', 'programa', 'trabalha numa padaria', 'faz mestrado em história', 'é tatuador', 'é advogada',
  'faz estágio em banco', 'é barista', 'está no ensino médio', 'é DJ nas horas vagas', 'vende roupa online', 'é dentista'
]
const CONTEXTOS = [
  'ouve música no ônibus', 'ouve música estudando', 'ouve música lavando louça', 'ouve música correndo',
  'só ouve música de fone no trabalho', 'ouve música dirigindo', 'ouve música de madrugada', 'ouve música no chuveiro',
  'ouve música bebendo com amigos', 'ouve música pra dormir', 'ouve música na academia', 'ouve música cozinhando'
]
const MANIAS = [
  'descobre música pelo TikTok', 'descobre música por trilha de série', 'só ouve álbum inteiro', 'odeia hit',
  'ouve a mesma música 40 vezes seguidas', 'gosta de música que a mãe ouvia', 'ouve o que o ex ouvia',
  'coleciona vinil', 'gosta de música triste em dia feliz', 'ouve rádio de carro ainda', 'só ouve ao vivo',
  'gosta de música de festa junina fora de época', 'tem playlist para cada humor', 'ouve música de videogame'
]

type Eixo = (rng: Rng) => string

const EIXOS: Eixo[] = [
  rng => `é de ${sortear(SIGNOS, rng)}`,
  rng => `é ${sortear(MBTI, rng)}`,
  rng => `é eneagrama tipo ${1 + Math.floor(rng() * 9)}`,
  rng => `tem ${16 + Math.floor(rng() * 30)} anos`,
  rng => `mora em ${sortear(CIDADES, rng)}`,
  rng => sortear(OCUPACOES, rng),
  rng => sortear(CONTEXTOS, rng),
  rng => sortear(MANIAS, rng),
  rng => {
    const meses = 1 + Math.floor(rng() * 11)
    return `terminou um namoro há ${meses} ${meses === 1 ? 'mês' : 'meses'}`
  },
  rng => `tem um ${sortear(['gato', 'cachorro', 'papagaio', 'hamster'], rng)}`,
  rng => `está ${sortear(['apaixonado', 'entediado', 'ansioso', 'de ressaca', 'feliz à toa', 'com saudade', 'irritado'], rng)}`
]

export const ESTILOS_DE_BIO = [
  'uma frase de filme famosa, sem dizer o filme',
  'uma frase em inglês, tudo em minúsculas',
  'uma frase curta em português com UM erro de digitação de quem digita rápido',
  'uma frase com gíria de internet brasileira (kkkk, sla, pfvr, mds, slk, tlgd)',
  'um meme de internet, qualquer um',
  'uma pergunta sem resposta',
  'uma palavra só',
  'só emojis, de 2 a 4',
  'um status de MSN de 2008',
  'uma citação de livro, sem dizer o livro',
  'uma reclamação boba sobre o dia de hoje',
  'o que a pessoa comeu hoje',
  'uma ordem absurda para quem está lendo',
  'uma frase em espanhol',
  'uma frase que termina no meio',
  'um cargo inventado e pomposo',
  'uma frase de biscoito da sorte',
  'só um número ou uma data, sem explicação',
  'uma frase de auto-ajuda com ironia',
  'uma frase em CAIXA ALTA',
  'uma piada ruim de tiozão',
  'uma frase de dinossauro de e-mail corporativo (segue em anexo, att)',
  'uma frase em inglês misturado com português',
  'uma frase de letra de música brasileira antiga, sem dizer qual',
  'um verso de poesia, sem dizer o poeta',
  'uma frase de fã de futebol sobre o time, sem dizer o time',
  'um "oi" ou equivalente, o mais preguiçoso possível',
  'uma frase de quem acabou de acordar',
  'uma frase de horóscopo genérica de revista (sem citar signo)',
  'uma frase de adesivo de carro'
] as const

/**
 * Ponto de partida da bio. Sem isto o modelo cai sempre no mesmo lugar (na
 * primeira rodada, 3 de 4 bios eram sobre "a janela do quarto"). O assunto é
 * sorteado aqui e nunca tem a ver com música ou com a pessoa do brief.
 */
export const ASSUNTOS_DE_BIO = [
  'fila do banco', 'pão com manteiga', 'o wi-fi', 'segunda-feira', 'um filme de ação dos anos 90', 'trânsito',
  'gelatina', 'o elevador', 'meias', 'uma planta que morreu', 'o tempo (clima)', 'boleto', 'uma piscina vazia',
  'pipoca', 'o dentista', 'um pombo', 'a lua', 'macarrão', 'um ônibus lotado', 'férias', 'o vizinho', 'café frio',
  'uma escada rolante', 'sorvete', 'o mar', 'uma reunião que podia ser e-mail', 'um sapato apertado', 'capivara',
  'a academia', 'o alarme do celular', 'batata frita', 'um aeroporto de madrugada', 'a chuva', 'uma mesa de sinuca',
  'o sofá', 'um ventilador', 'domingo à tarde', 'a padaria', 'um erro 404', 'um guarda-chuva quebrado', 'coxinha',
  'o ar-condicionado', 'um dinossauro', 'uma máquina de lavar', 'a pia cheia', 'a internet discada', 'uma foto antiga',
  'um parquinho', 'o horário de verão', 'um controle remoto sem pilha', 'a Netflix', 'uma formiga', 'espelho',
  'um pneu furado', 'o micro-ondas', 'a praia', 'mochila', 'um gato de rua', 'uma cadeira de plástico', 'a lanchonete'
] as const

export interface Brief {
  tracos: string[]
  generos: [string, string]
  decada: string
  idioma: string
  quantidade: 1 | 2 | 3
  /** null = este perfil não tem bio; o prompt nem pede. */
  bioEstilo: string | null
  /** Assunto sorteado para a bio (só faz sentido com `bioEstilo`). */
  bioAssunto: string
}

function sortear<T>(lista: readonly T[], rng: Rng): T {
  return lista[Math.floor(rng() * lista.length)]
}

export function sortearBrief(rng: Rng = Math.random): Brief {
  const g1 = sortear(GENEROS, rng)
  let g2 = sortear(GENEROS, rng)
  while (g2 === g1) g2 = sortear(GENEROS, rng)

  const qtdTracos = 1 + Math.floor(rng() * 2)
  const eixos = new Set<Eixo>()
  while (eixos.size < qtdTracos) eixos.add(sortear(EIXOS, rng))

  // 1–3 faixas com peso em 2: pesos 25/45/30.
  const r = rng()
  const quantidade: 1 | 2 | 3 = r < 0.25 ? 1 : r < 0.7 ? 2 : 3

  return {
    tracos: [...eixos].map(e => e(rng)),
    generos: [g1, g2],
    decada: sortear(DECADAS, rng),
    idioma: sortear(IDIOMAS, rng),
    quantidade,
    bioEstilo: rng() < FRACAO_SEM_BIO ? null : sortear(ESTILOS_DE_BIO, rng),
    bioAssunto: sortear(ASSUNTOS_DE_BIO, rng)
  }
}

// ---------------------------------------------------------------------------
// O prompt

export interface FaixaEscolhida {
  artist: string
  title: string
}

export function formatarEscolhida(f: { artist: string; title: string }): string {
  return `${f.artist} – ${f.title}`
}

export function montarPrompt(brief: Brief, jaEscolhidas: readonly string[]): string {
  const linhas = [
    `Uma pessoa fictícia: ${brief.tracos.join(', ')}. Ela ouve ${brief.generos[0]} e ${brief.generos[1]}, principalmente ${brief.decada}, em ${brief.idioma}.`,
    `Escolha ${brief.quantidade} ${brief.quantidade === 1 ? 'música REAL' : 'músicas REAIS'} que ela salvaria (existem no Deezer; misture conhecida e obscura; nada de cover, remix ou ao vivo; artistas diferentes entre si).`
  ]
  const memoria = jaEscolhidas.slice(-MEMORIA_DE_FAIXAS)
  if (memoria.length) linhas.push(`Não escolha nenhuma destas: ${memoria.join('; ')}.`)
  if (brief.bioEstilo) {
    linhas.push(
      `Bio do perfil, até ${BIO_MAX} caracteres, sem hashtag, tendo como ponto de partida "${brief.bioAssunto}" (não precisa citar). ` +
        'A bio NÃO tem nenhuma relação com a pessoa descrita acima nem com as músicas: nada de música, artista, gênero, signo, personalidade, idade, cidade, trabalho, bicho, namoro ou humor. Nem por alusão, nem em emoji. É uma frase solta sobre qualquer outra coisa, como as pessoas escrevem no Instagram. ' +
        `FORMATO OBRIGATÓRIO da bio: ${brief.bioEstilo}.`
    )
  }
  linhas.push(
    brief.bioEstilo
      ? 'Responda SÓ o JSON: {"tracks":[{"artist":"","title":""}],"bio":""}'
      : 'Responda SÓ o JSON: {"tracks":[{"artist":"","title":""}]}'
  )
  return linhas.join('\n')
}

const SYSTEM = 'Você inventa o gosto musical de pessoas fictícias para um site de música brasileiro. Responda apenas com JSON válido, sem comentários.'

// ---------------------------------------------------------------------------
// A chamada

export interface RespostaIA {
  tracks: FaixaEscolhida[]
  bio: string | null
}

/**
 * Lê o JSON da resposta com tolerância: aceita cerca de ```json, texto em
 * volta, `tracks` faltando ou malformado (vira []). Bio vazia/não-string vira
 * null; bio maior que o limite é cortada.
 */
export function interpretarResposta(conteudo: string): RespostaIA {
  const inicio = conteudo.indexOf('{')
  const fim = conteudo.lastIndexOf('}')
  if (inicio === -1 || fim <= inicio) return { tracks: [], bio: null }

  let bruto: { tracks?: unknown; bio?: unknown }
  try {
    bruto = JSON.parse(conteudo.slice(inicio, fim + 1))
  } catch {
    return { tracks: [], bio: null }
  }

  const tracks: FaixaEscolhida[] = []
  if (Array.isArray(bruto.tracks)) {
    for (const t of bruto.tracks as { artist?: unknown; title?: unknown }[]) {
      if (typeof t?.artist === 'string' && typeof t?.title === 'string' && t.artist.trim() && t.title.trim()) {
        tracks.push({ artist: t.artist.trim(), title: t.title.trim() })
      }
    }
  }

  let bio: string | null = null
  if (typeof bruto.bio === 'string') {
    const limpa = bruto.bio.replace(/#\S+/g, '').replace(/\s+/g, ' ').trim()
    if (limpa) bio = limpa.length > BIO_MAX ? limpa.slice(0, BIO_MAX).trimEnd() : limpa
  }

  return { tracks: tracks.slice(0, 3), bio }
}

export interface Uso {
  prompt_tokens: number
  completion_tokens: number
}

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; code?: number }
}

export interface ResultadoIA extends RespostaIA {
  brief: Brief
  uso: Uso
}

/**
 * Uma chamada ao OpenRouter para um perfil. `jaEscolhidas` é a memória do
 * lote (`formatarEscolhida` de cada faixa já usada), da qual só as últimas
 * `MEMORIA_DE_FAIXAS` vão no prompt.
 *
 * Se o modelo não aceitar `response_format` (400), tenta de novo sem — a
 * leitura do JSON já é tolerante. Erro de rede, 5xx e 429 lançam; o
 * chamador decide se pula o perfil.
 */
export async function gerarGostoMusical(
  jaEscolhidas: readonly string[],
  opts: { rng?: Rng; brief?: Brief; apiKey?: string; model?: string; fetchImpl?: typeof fetch } = {}
): Promise<ResultadoIA> {
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error('OPENROUTER_API_KEY não está no .env')
  const model = opts.model ?? OPENROUTER_MODEL
  const fetchImpl = opts.fetchImpl ?? fetch
  const brief = opts.brief ?? sortearBrief(opts.rng)

  const corpo = {
    model,
    temperature: 1.0,
    max_tokens: 400,
    // O hy4-preview é um modelo de raciocínio: sem isto ele gasta os 400
    // tokens inteiros pensando em qual MPB escolher e devolve `content: null`.
    // Desligado, a resposta custa ~40 tokens. Modelos sem raciocínio ignoram.
    reasoning: { enabled: false },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: montarPrompt(brief, jaEscolhidas) }
    ]
  }

  const chamar = async (comFormato: boolean): Promise<Response> =>
    fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.mirsui.com',
        'X-Title': 'Mirsui seed'
      },
      body: JSON.stringify(comFormato ? { ...corpo, response_format: { type: 'json_object' } } : corpo)
    })

  let r = await chamar(true)
  if (r.status === 400) r = await chamar(false)
  if (!r.ok) throw new Error(`OpenRouter respondeu ${r.status}: ${(await r.text()).slice(0, 300)}`)

  const json = (await r.json()) as ChatCompletion
  if (json.error) throw new Error(`OpenRouter: ${json.error.message ?? 'erro sem mensagem'}`)
  const conteudo = json.choices?.[0]?.message?.content ?? ''

  const resposta = interpretarResposta(conteudo)
  return {
    tracks: resposta.tracks,
    // Sem estilo sorteado, nem pedimos bio — mas se o modelo mandar, ignora.
    bio: brief.bioEstilo ? resposta.bio : null,
    brief,
    uso: {
      prompt_tokens: json.usage?.prompt_tokens ?? 0,
      completion_tokens: json.usage?.completion_tokens ?? 0
    }
  }
}

// ---------------------------------------------------------------------------
// Resolução no Deezer

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3)
  )
}

function compartilhaToken(a: string, b: string): boolean {
  const tb = tokens(b)
  for (const t of tokens(a)) if (tb.has(t)) return true
  return false
}

/**
 * O primeiro resultado do Deezer é a faixa pedida? Casamento frouxo: artista
 * OU título precisam compartilhar uma palavra de 3+ letras com o pedido.
 * Exposto para teste.
 */
export function casa(pedida: FaixaEscolhida, achada: FaixaDaBusca): boolean {
  return compartilhaToken(pedida.artist, achada.artist) || compartilhaToken(pedida.title, achada.title)
}

/** Uma escolha da IA → a faixa do Deezer, ou null se não acha ou não casa. */
export async function resolverFaixa(pedida: FaixaEscolhida): Promise<FaixaDaBusca | null> {
  const [achada] = await searchTracks(`${pedida.artist} ${pedida.title}`, 1)
  return achada && casa(pedida, achada) ? achada : null
}

/**
 * Resolve as escolhas da IA em faixas do Deezer. Pula o que não acha ou não
 * casa, e o que repete (`uri`) dentro do próprio perfil.
 */
export async function resolverFaixas(escolhidas: readonly FaixaEscolhida[]): Promise<FaixaDaBusca[]> {
  const resolvidas: FaixaDaBusca[] = []
  const vistas = new Set<string>()
  for (const pedida of escolhidas) {
    const achada = await resolverFaixa(pedida)
    if (!achada || vistas.has(achada.uri)) continue
    vistas.add(achada.uri)
    resolvidas.push(achada)
  }
  return resolvidas
}
