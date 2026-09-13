import type { getTrackRank } from '../lib/deezer'

/** One observation per track in this run, including shared transient failures. */
export function sharedStakeRank(read: typeof getTrackRank) {
  const byTrack = new Map<string, ReturnType<typeof getTrackRank>>()
  const stats = { uniqueTracks: 0, sharedReads: 0 }
  const lookup = (id: string) => {
    let result = byTrack.get(id)
    if (!result) {
      stats.uniqueTracks++
      result = read(id, 'stakes')
      byTrack.set(id, result)
    } else stats.sharedReads++
    return result
  }
  return Object.assign(lookup, { stats })
}
