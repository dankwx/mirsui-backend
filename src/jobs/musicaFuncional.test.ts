import assert from 'node:assert/strict'
import test from 'node:test'
import { ehMusicaFuncional } from './catalogDiscovery'

test('pega os artistas e álbuns funcionais que estavam no catálogo em 20/11/2026', () => {
  for (const nome of [
    'Sleep Songs 101', 'Relaxation Sleep Meditation', 'Relaxing Instrumental Music',
    'Bedtime Lullabies', 'Reiki Music', 'Nature Sounds Nature Music', 'Calming Sounds',
    'Musica Relajante', 'Musica Relaxante', 'Relaxamento', 'Ruído Branco',
    'Binaural Beats Brain Waves Isochronic Tones Brainwave Entrainment', '528Hz Repairs DNA',
    '432 Hz', 'Música para Relajarse Profundamente', 'Música para Relaxar Maestro',
    'Baby Lullaby Music Academy', 'White Noise For Babies', 'Chakra Balancing Sound Therapy',
    'Study Music & Sounds', 'Tinnitus Aid', 'Anxiety Relief', 'Canções de Ninar 101',
    'Soothing Sounds of Nature | Calming Sounds | Sleep', 'Entspannungsmusik Meer',
    'Guided Meditation Music Zone', 'Tibetan Singing Bowls for Relaxation', 'Heavy Rain Sounds',
  ]) assert.ok(ehMusicaFuncional(nome), nome)
})

test('não pega música de verdade com palavra parecida', () => {
  for (const nome of [
    'Sleep Token', 'Sleeping At Last', 'Armor for Sleep', 'Sleeping With Sirens',
    'Sleeping with Ghosts', 'The Meditations', 'Meditations', 'Meditação', 'Relax',
    'Welcome to the Pleasuredome', 'Yoga Lin', 'Spa', 'Rain', 'Rainbow', 'Purple Rain',
    'Nirvana', 'Zen', 'Max Richter', 'Sleep', 'Hz', 'Deep Purple', 'Natural', 'Calma',
    'Blinding Lights', 'Herbert von Karajan', 'Ethel Ennis', 'Spain', 'Ocean Eyes',
  ]) assert.ok(!ehMusicaFuncional(nome), nome)
})

test('olha todos os nomes e ignora os vazios', () => {
  assert.ok(ehMusicaFuncional(null, undefined, 'Deep Sleep Music'))
  assert.ok(ehMusicaFuncional('Artista Qualquer', 'Relaxing Piano'))
  assert.ok(!ehMusicaFuncional(null, undefined, ''))
  assert.ok(!ehMusicaFuncional())
})
