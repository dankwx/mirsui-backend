import cron from 'node-cron'
import { buildApp } from './app'
import { runStakeSnapshot } from './jobs/stakeSnapshot'
import { runCatalogSnapshot } from './jobs/catalogSnapshot'
import { pingHealthcheck } from './lib/healthcheck'
import { supabaseAdmin } from './lib/supabase'

const port = Number(process.env.PORT) || 3000

const app = await buildApp()

const FUSO = 'America/Sao_Paulo'

// POR QUE `recoverMissedExecutions` EM TODOS OS CRONS DAQUI
//
// O node-cron casa UM segundo por dia: '0 5 * * *' vira '0 0 5 * * *' e, dos
// 86.400 segundos do dia, só 05:00:00 casa. O laço do scheduler é uma corrente
// de setTimeout(…, 1000) e, sem esta opção, ele examina apenas o segundo
// corrente — se um único tique atrasar e pular aquele segundo, o job não roda.
// Sem erro, sem log, sem ping: o dia simplesmente não acontece.
//
// Foi o que houve em 20/09/2026. O processo estava de pé desde 15/09, o log de
// erro vazio, a máquina ociosa, e o cron das 09:00 disparou normal — cada
// tarefa tem seu próprio scheduler, então um sobreviveu e o outro não.
//
// Com a opção ligada, o tique atrasado reexamina os segundos que passaram
// desde o anterior e o disparo acontece com alguns segundos de atraso, em vez
// de se perder. Ligar isso é seguro porque os dois jobs são idempotentes por
// dia: rodar de novo atualiza a medição, não duplica ponto no histórico.
const AGENDA = { timezone: FUSO, recoverMissedExecutions: true } as const

// Job diário dos Stakes: 1x por dia às 09:00 (timezone de SP).
// Idempotente por data, então rodar mais de uma vez no mesmo dia não duplica pontos.
cron.schedule(
  '0 9 * * *',
  () => {
    const hc = process.env.HC_STAKES_URL
    void pingHealthcheck(hc, '/start')
    runStakeSnapshot(app.log)
      .then(() => pingHealthcheck(hc))
      .catch((err) => {
        app.log.error({ err }, 'Falha no job de snapshot dos stakes')
        return pingHealthcheck(hc, '/fail')
      })
  },
  AGENDA
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

function dispararObservatorio(origem: 'cron' | 'rede de segurança') {
  if (observatorioRodando) {
    app.log.warn({ origem }, 'Observatório ainda rodando da execução anterior — pulando')
    return
  }
  observatorioRodando = true
  // O "pulando" acima não pinga nada: um dia sem rodada é exatamente o que
  // o healthchecks tem que apontar.
  const hc = process.env.HC_OBSERVATORIO_URL
  void pingHealthcheck(hc, '/start')
  runCatalogSnapshot(app.log)
    .then(() => pingHealthcheck(hc))
    .catch((err) => {
      app.log.error({ err, origem }, 'Falha no job do Observatório')
      return pingHealthcheck(hc, '/fail')
    })
    .finally(() => {
      observatorioRodando = false
    })
}

cron.schedule('0 5 * * *', () => dispararObservatorio('cron'), AGENDA)

// -----------------------------------------------------------------------
// Rede de segurança do Observatório
// -----------------------------------------------------------------------
// `recoverMissedExecutions` cobre o tique atrasado, que é o caso comum. Não
// cobre o resto: processo derrubado às 04:59 e de volta às 05:30, máquina
// suspensa por cima da janela, deploy no meio do horário. Em todos eles o
// cron não tem como saber que devia algo.
//
// Então a pergunta é feita ao banco, que é quem guarda a resposta de verdade:
// quando foi a última medição do catálogo? `observed_tracks.last_checked_at`
// só é escrito pelo Observatório (migrations 009 e 021), então o maior valor
// da coluna é o fim da última rodada.
//
// Em operação normal esse valor nunca passa de ~22h de idade: a rodada das
// 05:00 termina umas 07:00 e a seguinte já começa 22h depois. Passar de 25h
// significa que uma janela foi pulada.
const IDADE_MAXIMA_MS = 25 * 60 * 60 * 1000

// Uma tentativa de recuperação por dia, no máximo. Sem isto, uma rodada que
// falhasse cedo — Deezer fora do ar, banco recusando — deixaria last_checked_at
// velho e a rede de segurança ficaria chamando o job de hora em hora.
let recuperadoEm: string | null = null

function hojeEmSaoPaulo(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: FUSO })
}

async function conferirRodadaDoDia() {
  if (observatorioRodando) return
  const hoje = hojeEmSaoPaulo()
  if (recuperadoEm === hoje) return
  if (!supabaseAdmin) return

  const { data, error } = await supabaseAdmin
    .from('observed_tracks')
    .select('last_checked_at')
    .not('last_checked_at', 'is', null)
    .order('last_checked_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (!data?.last_checked_at) return

  const idadeMs = Date.now() - new Date(data.last_checked_at).getTime()
  if (idadeMs < IDADE_MAXIMA_MS) return

  recuperadoEm = hoje
  app.log.warn(
    { ultimaMedicao: data.last_checked_at, horas: Math.round(idadeMs / 3_600_000) },
    'Observatório: a janela do dia passou sem rodada — disparando pela rede de segurança'
  )
  dispararObservatorio('rede de segurança')
}

function conferirSemQuebrar() {
  conferirRodadaDoDia().catch((err) => {
    // A rede de segurança nunca pode derrubar o servidor nem virar ruído de
    // erro: se o banco não responder agora, a conferência da hora seguinte
    // resolve.
    app.log.warn({ err }, 'Observatório: conferência da rede de segurança falhou')
  })
}

// De hora em hora, e uma vez logo depois de subir — um processo que volta às
// 05:30 não deve esperar até 06:07 para descobrir que perdeu a janela.
cron.schedule('7 * * * *', conferirSemQuebrar, AGENDA)
setTimeout(conferirSemQuebrar, 60_000).unref()

try {
  await app.listen({ port, host: '0.0.0.0' })
  app.log.info(`🚀 Backend Mirsui rodando na porta ${port}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
