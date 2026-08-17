// src/lib/stakePoints.ts
// Regras de pontuação da feature Stakes (ver Stake.md).
//
// A fonte da métrica é o Deezer (o Spotify deixou de expor popularity):
//   - popularidade da faixa  <- Deezer track.rank  (normalizado p/ 0-100)
//   - fama do artista         <- Deezer artist.nb_fan (escala log -> 0-100)

/**
 * Normaliza o `rank` do Deezer (~100k obscuro a ~985k hit) para 0-100.
 * Ex.: 107.970 -> 11, 417.559 -> 42, 984.833 -> 98.
 */
export function popScore(rank: number): number {
  return clamp01to100(Math.round((Number(rank) || 0) / 10000))
}

/**
 * Fama do artista a partir do nº de fãs do Deezer, em escala log (fãs crescem
 * exponencialmente). 7 ≈ log10(10 milhões). Ex.: 14,5M fãs -> 100, 1.195 -> 44.
 */
export function fameScore(nbFan: number): number {
  const n = Math.max(1, Number(nbFan) || 0)
  return clamp01to100(Math.round((Math.log10(n) / 7) * 100))
}

/**
 * Multiplicador travado no momento do stake.
 * Quanto MENOS famoso (artista + faixa), MAIOR o multiplicador.
 *
 *   fama = 0,6 * fame_artista + 0,4 * pop_faixa   (cada um 0-100)
 *   mult = 1 + (100 - fama)/100 * 2,5             -> ~x1,0 (famoso) a ~x3,5 (obscuro)
 *
 * O valor é congelado: o job diário sempre usa o multiplier salvo, nunca recalcula.
 */
export function computeMultiplier(artistFame: number, trackPopularity: number): number {
  const artist = clamp01to100(artistFame)
  const track = clamp01to100(trackPopularity)
  const fama = 0.6 * artist + 0.4 * track
  const mult = 1 + ((100 - fama) / 100) * 2.5
  // duas casas (coluna numeric(4,2))
  return Math.round(mult * 100) / 100
}

/**
 * Pontos ganhos numa medição, medidos contra a MARCA D'ÁGUA (o maior popScore
 * já atingido desde a ficha) — não contra a medição de ontem. Ver migration 028.
 *
 * A diferença importa: comparando com ontem, uma faixa que oscila paga a mesma
 * subida a cada ciclo, e o acumulado vira "soma de todas as subidas" em vez de
 * "o quanto ela subiu". Nos dados reais isso era 84 dos 103 pontos existentes.
 * Contra o pico, só bater o próprio recorde paga; recuperar queda não.
 *
 * Continua nunca negativo: cair não tira ponto, `accumulated_points` só sobe.
 */
export function computePointsGain(
  peakPopularity: number,
  currentPopularity: number,
  multiplier: number
): { dayGain: number; pointsGain: number; newPeak: number } {
  const dayGain = Math.max(0, currentPopularity - peakPopularity)
  const pointsGain = Math.round(dayGain * multiplier)
  const newPeak = Math.max(peakPopularity, currentPopularity)
  return { dayGain, pointsGain, newPeak }
}

function clamp01to100(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(100, Math.max(0, n))
}
