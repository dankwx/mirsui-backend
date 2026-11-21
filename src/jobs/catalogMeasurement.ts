import { faixasDaPlaylist, faixasDoAlbum, type FaixaObservada } from '../lib/deezerCatalog'

export interface LinhaParaMedir {
  deezer_track_id: string
  deezer_artist_id: string | null
  deezer_album_id: string | null
  title: string
  artist_name: string
  source_list: string | null
}

/**
 * Agrupa a fila inteira antes de dividi-la em blocos: duas faixas do mesmo
 * álbum em páginas diferentes ainda custam uma única consulta. A primeira
 * ocorrência define a posição do grupo. Só inclui faixas admitidas na fila;
 * as outras músicas da resposta não são descobertas nem medidas aqui.
 *
 * Uma faixa sozinha vai direto a /track (mesmo custo e metadados completos).
 * Falha, ausência ou rank inválido voltam ao caminho individual, que é o único
 * autorizado a concluir que uma faixa foi removida.
 */
export async function* medirPorAlbum(
  linhas: LinhaParaMedir[],
  consultarAlbum: typeof faixasDoAlbum = faixasDoAlbum
) {
  const unicas = [...new Map(linhas.map((r) => [r.deezer_track_id, r])).values()]
  const porAlbum = new Map<string, LinhaParaMedir[]>()
  for (const r of unicas) {
    if (!r.deezer_album_id) continue
    const grupo = porAlbum.get(r.deezer_album_id) ?? []
    grupo.push(r)
    porAlbum.set(r.deezer_album_id, grupo)
  }

  const agendados = new Set<string>()
  const tarefas: { albumId: string | null; linhas: LinhaParaMedir[] }[] = []
  for (const r of unicas) {
    const albumId = r.deezer_album_id
    const grupo = albumId ? porAlbum.get(albumId)! : []
    if (albumId && grupo.length > 1) {
      if (agendados.has(albumId)) continue
      agendados.add(albumId)
      tarefas.push({ albumId, linhas: grupo })
    } else {
      tarefas.push({ albumId: null, linhas: [r] })
    }
  }

  // Limita memória em voo e entrega progresso para gravação entre os blocos.
  const BLOCO = 50
  for (let i = 0; i < tarefas.length; i += BLOCO) {
    const respostas = await Promise.all(tarefas.slice(i, i + BLOCO).map(async (t) => ({
      ...t,
      resposta: t.albumId ? await consultarAlbum(t.albumId) : null,
    })))
    const medidas: FaixaObservada[] = []
    const individuais: LinhaParaMedir[] = []
    let albunsConsultados = 0
    for (const { albumId, linhas: grupo, resposta } of respostas) {
      if (albumId) albunsConsultados++
      if (!resposta || resposta.falhou) {
        individuais.push(...grupo)
        continue
      }
      const porId = new Map(resposta.faixas.map((f) => [f.deezer_track_id, f]))
      for (const r of grupo) {
        const f = porId.get(r.deezer_track_id)
        if (!f || typeof f.rank !== 'number' || !Number.isFinite(f.rank)) {
          individuais.push(r)
          continue
        }
        medidas.push({
          deezer_track_id: r.deezer_track_id,
          deezer_artist_id: f.deezer_artist_id ?? r.deezer_artist_id,
          deezer_album_id: albumId,
          isrc: f.isrc,
          title: f.title ?? r.title,
          artist_name: f.artist_name ?? r.artist_name,
          album_name: null,
          cover_md5: null,
          genre: null,
          source_list: r.source_list ?? 'chart:0',
          rank: f.rank,
          // Duração, explícito e prévia vêm na mesma resposta; data e
          // participações não (só /track traz), e ficam como estão no banco.
          duration_seconds: f.duration_seconds,
          explicit_lyrics: f.explicit_lyrics,
          has_preview: f.has_preview,
        })
      }
    }
    yield { medidas, individuais, albunsConsultados }
  }
}

/**
 * Mede a fila pelas playlists de medição, antes do caminho por álbum.
 *
 * Uma playlist de 2.000 faixas é uma requisição; as mesmas faixas custam
 * centenas pelo álbum e por /track. O casamento é SÓ pelo id do Deezer: o
 * TuneMyMusic, que monta as playlists, casa por ISRC e às vezes escolhe outra
 * edição da mesma música (13% em 16/10/2026), com outro rank. Faixa da
 * playlist que não está na fila é ignorada; faixa da fila que não veio com o
 * próprio id, veio sem rank ou veio com `readable: false` fica para o caminho
 * atual, que é o único autorizado a concluir que uma faixa foi removida.
 *
 * Entrega uma playlist por vez, para a gravação acontecer entre elas. Quem
 * chama tira da fila o que foi medido antes de passar o resto a medirPorAlbum.
 */
export async function* medirPorPlaylist(
  linhas: LinhaParaMedir[],
  playlists: string[],
  consultarPlaylist: typeof faixasDaPlaylist = faixasDaPlaylist
) {
  const naFila = new Map(linhas.map((r) => [r.deezer_track_id, r]))
  const medidasAntes = new Set<string>()

  // Duas em voo, no máximo. O gateway tem 4 conexões para todo mundo e uma
  // página de 2.000 segura a sua por até 5 s: com 4 playlists ao mesmo tempo, a
  // etapa ocuparia todas e quem abre o site esperaria. São ~156 páginas por
  // noite, ~6 min assim.
  const BLOCO = 2
  for (let i = 0; i < playlists.length; i += BLOCO) {
    const respostas = await Promise.all(playlists.slice(i, i + BLOCO).map(async (id) => ({
      id,
      resposta: await consultarPlaylist(id),
    })))
    for (const { id, resposta } of respostas) {
      const medidas: FaixaObservada[] = []
      let semRank = 0
      if (!resposta.falhou) {
        for (const f of resposta.faixas) {
          const r = naFila.get(f.deezer_track_id)
          if (!r || medidasAntes.has(f.deezer_track_id)) continue
          if (typeof f.rank !== 'number' || !Number.isFinite(f.rank) || f.readable === false) {
            semRank++
            continue
          }
          medidasAntes.add(f.deezer_track_id)
          medidas.push({
            deezer_track_id: r.deezer_track_id,
            deezer_artist_id: f.deezer_artist_id ?? r.deezer_artist_id,
            deezer_album_id: f.deezer_album_id ?? r.deezer_album_id,
            isrc: f.isrc,
            title: f.title ?? r.title,
            artist_name: f.artist_name ?? r.artist_name,
            album_name: f.album_name,
            cover_md5: f.cover_md5,
            genre: null,
            source_list: r.source_list ?? 'chart:0',
            rank: f.rank,
            // A faixa da playlist traz duração, explícito e prévia, como a do
            // álbum; data e participações só /track traz.
            duration_seconds: f.duration_seconds,
            explicit_lyrics: f.explicit_lyrics,
            has_preview: f.has_preview,
          })
        }
      }
      yield {
        playlistId: id,
        falhou: resposta.falhou,
        lidas: resposta.faixas.length,
        semRank,
        medidas,
      }
    }
  }
}

/**
 * O turno das faixas que a playlist não mediu (OBS_CADENCIA_FORA_DE_PLAYLIST).
 *
 * Quem está numa playlist de medição sai de graça todo dia: uma requisição
 * mede 2.000. Quem ficou fora (a edição que o TuneMyMusic trocou, a que ainda
 * não subiu, a de uma playlist que falhou na noite) custa ~1 requisição a cada
 * 2 faixas, todo dia, e é isso que limita o tamanho do catálogo medido.
 * Com cadência C, cada uma dessas faixas é medida um dia a cada C.
 *
 * Por turno fixo, e não por "C dias desde a última medição": no dia em que a
 * regra entra, todas as de fora foram medidas ontem, e venceriam juntas no
 * dia C. O dia de pico custaria o mesmo de antes e o teto não subiria. O turno
 * reparte as de fora em C partes desde a primeira noite.
 *
 * O turno é do ÁLBUM, não da faixa: as faixas de fora do mesmo álbum saem no
 * mesmo dia e continuam custando uma requisição a /album/{id}/tracks. Pelo id
 * da faixa, um álbum com três faixas de fora pagaria uma requisição por dia
 * em vez de uma a cada três.
 *
 * `sempre` são as que alguém acompanha (ficha ou save, prioridade 0 da
 * cadência): ficam todo dia, em playlist ou não.
 */
export function separarPeloTurno<T extends Pick<LinhaParaMedir, 'deezer_track_id' | 'deezer_album_id'>>(
  linhas: T[],
  dia: number,
  cadencia: number,
  sempre: ReadonlySet<string>
): { hoje: T[]; espacadas: number } {
  if (!(cadencia > 1)) return { hoje: linhas, espacadas: 0 }
  const hoje = linhas.filter((r) =>
    sempre.has(r.deezer_track_id)
    || (turnoDe(r.deezer_album_id ?? r.deezer_track_id) + dia) % cadencia === 0)
  return { hoje, espacadas: linhas.length - hoje.length }
}

/** FNV-1a de 32 bits: espalha ids sequenciais do Deezer por igual entre os turnos. */
function turnoDe(chave: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < chave.length; i++) {
    h ^= chave.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
