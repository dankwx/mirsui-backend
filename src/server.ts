import cron from 'node-cron'
import { buildApp } from './app'
import { runCravadaSnapshot } from './jobs/cravadaSnapshot'

const port = Number(process.env.PORT) || 3000

const app = await buildApp()

// Job diário das Cravadas: 1x por dia às 09:00 (timezone de SP).
// Idempotente por data, então rodar mais de uma vez no mesmo dia não duplica pontos.
cron.schedule(
  '0 9 * * *',
  () => {
    runCravadaSnapshot(app.log).catch((err) =>
      app.log.error({ err }, 'Falha no job de snapshot das cravadas')
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
