import { faixasDoAlbum, type FaixaObservada } from '../lib/deezerCatalog'

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
