import cron from 'node-cron'
import { buildApp } from './app'
import { runStakeSnapshot } from './jobs/stakeSnapshot'
import { runCatalogSnapshot } from './jobs/catalogSnapshot'

const port = Number(process.env.PORT) || 3000

const app = await buildApp()

// Job diário dos Stakes: 1x por dia às 09:00 (timezone de SP).
// Idempotente por data, então rodar mais de uma vez no mesmo dia não duplica pontos.
cron.schedule(
  '0 9 * * *',
  () => {
    runStakeSnapshot(app.log).catch((err) =>
      app.log.error({ err }, 'Falha no job de snapshot dos stakes')
    )
  },
  { timezone: 'America/Sao_Paulo' }
)

// Observatório: mede o catálogo às 05:00, longe das 09:00 dos Stakes — os dois
// batem na mesma API do Deezer e dividir a janela evita disputar o rate limit.
// Também é idempotente por dia (índice único em track_popularity_history).
//
// A rodada leva minutos, não segundos, e cresce junto com o catálogo — não há
// teto de faixas por rodada, de propósito: ver src/jobs/catalogSnapshot.ts.
// A trava abaixo existe porque uma rodada lenta que atravessasse o horário da
// seguinte colocaria duas varreduras concorrendo pela mesma fila de
// requisições, dobrando o risco de quota.
let observatorioRodando = false
cron.schedule(
  '0 5 * * *',
  () => {
    if (observatorioRodando) {
      app.log.warn('Observatório ainda rodando da execução anterior — pulando')
      return
    }
    observatorioRodando = true
    runCatalogSnapshot(app.log)
      .catch((err) => app.log.error({ err }, 'Falha no job do Observatório'))
      .finally(() => {
        observatorioRodando = false
      })
  },
  { timezone: 'America/Sao_Paulo' }
)

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`🚀 Backend Mirsui rodando na porta ${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
