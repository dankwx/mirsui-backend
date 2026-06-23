import cron from 'node-cron'
import { buildApp } from './app'
import { runStakeSnapshot } from './jobs/stakeSnapshot'

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

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`🚀 Backend Mirsui rodando na porta ${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
