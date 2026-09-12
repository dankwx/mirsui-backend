// src/seed/ficha.ts
// A ficha de um perfil semeado: a mesma linha em `tracks` que a rota
// `POST /tracks/claim` (`src/routes/claims.ts`) grava — mas com a service
// role, porque a rota exige o token do usuário e não vale a pena logar como
// cada fake só para salvar duas músicas.
//
// A conta é a da rota, pela mesma função (`src/lib/gravacao.ts`):
//   - a gravação é `isrc OU track_uri` (as linhas antigas só têm a uri);
//   - `position` = quantas fichas essa gravação já tem + 1;
//   - `popularity` = `popScore(rank)` do Deezer, como no save real;
//   - `discover_rating` = 100 - popularity + 100/position.
//
// A única diferença é a data: `claimedat` é sorteada entre a entrada da conta
// e agora, para o acervo não parecer que nasceu todo no mesmo minuto.
// Consequência aceita: a POSIÇÃO é pela ordem de inserção, não pela data
// sorteada — um semeado pode ter `position = 1` com `claimedat` de ontem
// enquanto o usuário real que salvou de verdade em março fica com 2. É o que
// a rota já faz hoje (a posição é a ordem de chegada no banco), e o script
// só cria fichas em gravações que a IA escolheu, quase todas sem ninguém.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { FaixaDaBusca } from '../lib/deezer'
import { filtroDaGravacao, discoverRating } from '../lib/gravacao'
import { popScore } from '../lib/stakePoints'
import type { Rng } from './username'

export interface FichaCriada {
  id: number
  position: number
  track_uri: string
  claimedat: string
}

/**
 * Um instante uniforme entre `depoisDe` (a entrada da conta) e `antesDe`
 * (agora). Se a janela for vazia ou invertida, devolve `antesDe` — a ficha
 * nunca fica antes da conta nem no futuro.
 */
export function sortearClaimedAt(depoisDe: Date, antesDe: Date = new Date(), rng: Rng = Math.random): Date {
  const inicio = depoisDe.getTime()
  const fim = antesDe.getTime()
  if (!(fim > inicio)) return new Date(fim)
  return new Date(inicio + Math.floor(rng() * (fim - inicio)))
}

/** O que a rota real gravaria para esta faixa nesta posição (exposto para teste). */
export function montarLinha(
  userId: string,
  faixa: FaixaDaBusca,
  position: number,
  claimedAt: Date
): Record<string, unknown> {
  const popularity = popScore(faixa.rank)
  return {
    track_url: `https://www.deezer.com/track/${faixa.deezerTrackId}`,
    track_uri: faixa.uri,
    isrc: faixa.isrc,
    track_title: faixa.title,
    artist_name: faixa.artist,
    // coluna NOT NULL; a busca do Deezer pode não trazer o álbum
    album_name: faixa.albumName ?? '',
    popularity,
    discover_rating: discoverRating(popularity, position),
    track_thumbnail: faixa.thumbnail,
    user_id: userId,
    position,
    claimedat: claimedAt.toISOString()
  }
}

/**
 * Grava UMA ficha para o perfil. Devolve null (sem gravar) se o perfil já tem
 * esta gravação — a mesma checagem que faz a rota responder 409.
 *
 * `claimedAt` vem pronto do chamador: o script sabe o `created_at` da conta e
 * sorteia com `sortearClaimedAt`.
 */
export async function criarFicha(
  admin: SupabaseClient,
  userId: string,
  faixa: FaixaDaBusca,
  claimedAt: Date
): Promise<FichaCriada | null> {
  const filtro = filtroDaGravacao(faixa.uri, faixa.isrc)

  const { data: existente, error: erroExistente } = await admin
    .from('tracks')
    .select('id')
    .eq('user_id', userId)
    .or(filtro)
    .limit(1)
    .maybeSingle()
  if (erroExistente) throw new Error(`ficha existente de ${userId}: ${erroExistente.message}`)
  if (existente) return null

  const { count, error: erroContagem } = await admin
    .from('tracks')
    .select('*', { count: 'exact', head: true })
    .or(filtro)
  if (erroContagem) throw new Error(`contagem da gravação ${faixa.uri}: ${erroContagem.message}`)

  const position = (count ?? 0) + 1
  const linha = montarLinha(userId, faixa, position, claimedAt)

  const { data, error: erroInsercao } = await admin
    .from('tracks')
    .insert([linha])
    .select('id, position, track_uri, claimedat')
    .single()
  if (erroInsercao) throw new Error(`ficha de ${userId} em ${faixa.uri}: ${erroInsercao.message}`)

  return data as FichaCriada
}

/**
 * As fichas de um perfil recém-semeado: uma por faixa resolvida, cada uma com
 * a própria data sorteada depois de `criadoEm`. Falha em uma faixa derruba o
 * perfil inteiro (o chamador apaga o usuário e a cascata leva o que entrou).
 */
export async function criarFichas(
  admin: SupabaseClient,
  userId: string,
  faixas: readonly FaixaDaBusca[],
  criadoEm: Date,
  opts: { agora?: Date; rng?: Rng } = {}
): Promise<FichaCriada[]> {
  const criadas: FichaCriada[] = []
  for (const faixa of faixas) {
    const ficha = await criarFicha(admin, userId, faixa, sortearClaimedAt(criadoEm, opts.agora, opts.rng))
    if (ficha) criadas.push(ficha)
  }
  return criadas
}
