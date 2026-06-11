import { buildApp } from './app'

const port = Number(process.env.PORT) || 3000

const app = await buildApp()

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`🚀 Backend Mirsui rodando na porta ${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
