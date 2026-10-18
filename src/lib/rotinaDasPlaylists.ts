// src/lib/rotinaDasPlaylists.ts
// As partes puras de src/scripts/rotinaDasPlaylists.ts (migration 045).

export type VoltouComo = 'id' | 'ilegivel' | 'trocada' | 'nao_veio'

/**
 * O que a playlist trouxe de cada faixa exportada para ela.
 *
 * Mesma regra da rodada (`medirPorPlaylist`): só conta o nosso id. Veio com o
 * nosso id e `readable: false` é "ilegivel", e reenviar não conserta. Veio
 * outra edição com o ISRC que mandamos é "trocada"; é a que vale reenviar pelo
 * nome.
 */
export function conferirExportadas(
  exportadas: { deezer_track_id: string; isrc: string | null }[],
  daPlaylist: { deezer_track_id: string; isrc: string | null; readable: boolean | null }[]
): Map<string, VoltouComo> {
  const porId = new Map(daPlaylist.map((f) => [f.deezer_track_id, f]))
  const isrcs = new Set(daPlaylist.flatMap((f) => (f.isrc ? [f.isrc.toUpperCase()] : [])))
  const resultado = new Map<string, VoltouComo>()
  for (const e of exportadas) {
    const f = porId.get(e.deezer_track_id)
    if (f) resultado.set(e.deezer_track_id, f.readable === false ? 'ilegivel' : 'id')
    else if (e.isrc && isrcs.has(e.isrc.toUpperCase())) resultado.set(e.deezer_track_id, 'trocada')
    else resultado.set(e.deezer_track_id, 'nao_veio')
  }
  return resultado
}

/**
 * O próximo número de playlist depois dos que já existem com este prefixo.
 * "Mirsui 156" → 157; "Mirsui trocadas 03" → 4. A "Mirsui trocadas" sem
 * número, do teste de 16/10, não conta.
 */
export function proximoNumero(rotulos: Iterable<string | null>, prefixo: string): number {
  const padrao = new RegExp(`^${prefixo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`)
  let maior = 0
  for (const r of rotulos) {
    const n = r?.match(padrao)?.[1]
    if (n) maior = Math.max(maior, Number(n))
  }
  return maior + 1
}

/** Uma linha de CSV: aspas só quando precisa, aspas internas dobradas. */
export function linhaCsv(campos: (string | number | null | undefined)[]): string {
  return campos
    .map((c) => {
      const s = c == null ? '' : String(c)
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    })
    .join(',')
}

/** Reparte em playlists de `porPlaylist`, numeradas a partir de `primeira`. */
export function repartir<T>(
  itens: T[],
  porPlaylist: number,
  rotulo: (n: number) => string,
  primeira: number
): { rotulo: string; itens: T[] }[] {
  const playlists: { rotulo: string; itens: T[] }[] = []
  for (let i = 0; i < itens.length; i += porPlaylist) {
    playlists.push({ rotulo: rotulo(primeira + i / porPlaylist), itens: itens.slice(i, i + porPlaylist) })
  }
  return playlists
}
