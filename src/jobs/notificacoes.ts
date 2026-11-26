// Os avisos por e-mail: a entrega da caixa de saída e o resumo semanal.
//
// O banco decide O QUE avisar (migrations/053_notificacoes.sql): o gatilho de
// `followers` cria o aviso de seguidor no momento do seguir, e
// `gerar_resumo_de_saltos` cria o resumo da semana. Aqui só se entrega.
//
// ENTREGA — a cada 30 s
//   Reivindica as pendentes, monta o e-mail, manda pelo Resend e fecha cada
//   uma. 30 s é o "na hora" do aviso de seguidor sem custo: com a fila vazia a
//   consulta é um índice parcial vazio.
//
// RESUMO — segunda-feira, depois da rodada
//   O salto da semana compara a última medição com a de 7 dias antes, então
//   ele espera a rodada da segunda terminar. Se o backend passar a segunda
//   fora do ar, a terça gera. A semana é a ISO, no fuso de São Paulo, e o
//   banco guarda quais já foram geradas: rodar de novo não duplica.

import type { SupabaseClient } from '@supabase/supabase-js'
import cron from 'node-cron'
import { criarEnvioResend, type EnviarEmail } from '../lib/email'
import {
  linkDeDescadastro,
  montarEmail,
  type NotificacaoParaEmail,
} from '../lib/modelosDeEmail'

type Log = {
  info: (o: unknown, m?: string) => void
  warn: (o: unknown, m?: string) => void
  error: (o: unknown, m?: string) => void
}

const FUSO = 'America/Sao_Paulo'
const LOTE = 20

// ---------------------------------------------------------------------------
// Entrega
// ---------------------------------------------------------------------------

export interface DepsDaEntrega {
  db: SupabaseClient
  enviar: EnviarEmail
  site: string
  /** teto de avisos por 24 h, abaixo dos 100/dia do Resend gratuito */
  limiteDia: number
  log: Log
  /** espaço entre dois envios; a API do Resend aceita 2 por segundo */
  pausaMs?: number
}

export async function entregarNotificacoes(deps: DepsDaEntrega) {
  const { db, enviar, site, limiteDia, log, pausaMs = 600 } = deps
  const resultado = { enviadas: 0, falhas: 0, semVaga: false }

  const { count, error: erroConta } = await db
    .from('notificacoes')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'enviada')
    .gte('enviada_em', new Date(Date.now() - 24 * 3600_000).toISOString())
  if (erroConta) throw erroConta

  const vaga = Math.min(LOTE, limiteDia - (count ?? 0))
  if (vaga <= 0) {
    resultado.semVaga = true
    return resultado
  }

  const { data, error } = await db.rpc('reivindicar_notificacoes', { p_limite: vaga })
  if (error) throw error
  const lote = (data ?? []) as NotificacaoParaEmail[]

  for (const [i, n] of lote.entries()) {
    if (i > 0 && pausaMs > 0) await new Promise((r) => setTimeout(r, pausaMs))

    let erro: string | null = null
    const email = montarEmail(n, site)
    if (!email) {
      erro = `sem modelo para o aviso (${n.tipo})`
    } else {
      const descadastro = linkDeDescadastro(site, n.token, email.preferencia)
      try {
        await enviar({
          para: n.email,
          assunto: email.assunto,
          html: email.html,
          texto: email.texto,
          idempotencia: `mirsui-notificacao-${n.id}`,
          cabecalhos: {
            'List-Unsubscribe': `<${descadastro}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        })
      } catch (err) {
        erro = err instanceof Error ? err.message : String(err)
      }
    }

    const { error: erroFim } = await db.rpc('concluir_notificacao', {
      p_id: n.id,
      p_erro: erro,
    })
    if (erroFim) log.error({ err: erroFim, id: n.id }, 'Avisos: não consegui fechar o aviso')

    if (erro) {
      resultado.falhas++
      log.warn({ id: n.id, tipo: n.tipo, tentativa: n.tentativas, erro }, 'Avisos: envio falhou')
    } else {
      resultado.enviadas++
    }
  }

  if (lote.length > 0) log.info(resultado, 'Avisos: entrega')
  return resultado
}

// ---------------------------------------------------------------------------
// Resumo semanal
// ---------------------------------------------------------------------------

/** Dia, hora e semana ISO (IYYY-IW, como o to_char do Postgres) em São Paulo. */
export function agoraEmSaoPaulo(agora = new Date()) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: FUSO,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value])
  )
  const ano = Number(partes.year)
  const mes = Number(partes.month)
  const dia = Number(partes.day)
  const hora = Number(partes.hour)

  // Semana ISO: a do dia que é a quinta-feira desta semana.
  const data = new Date(Date.UTC(ano, mes - 1, dia))
  const diaDaSemana = data.getUTCDay() || 7 // 1 = segunda … 7 = domingo
  data.setUTCDate(data.getUTCDate() + 4 - diaDaSemana)
  const anoIso = data.getUTCFullYear()
  const inicio = Date.UTC(anoIso, 0, 1)
  const semana = Math.ceil(((data.getTime() - inicio) / 86_400_000 + 1) / 7)

  return {
    diaDaSemana,
    hora,
    semana: `${anoIso}-${String(semana).padStart(2, '0')}`,
  }
}

/** Segunda depois das 07:00 com a rodada parada, ou terça de qualquer jeito. */
export function horaDoResumo(
  agora: { diaDaSemana: number; hora: number },
  rodadaEmCurso: boolean
): boolean {
  if (agora.diaDaSemana === 1) return agora.hora >= 7 && !rodadaEmCurso
  return agora.diaDaSemana === 2
}

export async function gerarResumoDaSemana(db: SupabaseClient, semana: string) {
  const { data, error } = await db.rpc('gerar_resumo_de_saltos', { p_semana: semana })
  if (error) throw error
  return data as { semana: string; pessoas?: number; jaGerado?: boolean }
}

// ---------------------------------------------------------------------------
// Agenda
// ---------------------------------------------------------------------------

export function agendarNotificacoes(opts: {
  db: SupabaseClient | null
  log: Log
  rodadaEmCurso: () => boolean
}) {
  const { db, log, rodadaEmCurso } = opts
  const apiKey = process.env.RESEND_API_KEY
  if (process.env.NOTIF_ATIVA === '0' || !apiKey || !db) {
    log.warn(
      { chave: Boolean(apiKey), serviceRole: Boolean(db), desligada: process.env.NOTIF_ATIVA === '0' },
      'Avisos por e-mail desligados'
    )
    return
  }

  const site = (process.env.SITE_URL || 'https://www.mirsui.com').replace(/\/+$/, '')
  const enviar = criarEnvioResend(apiKey, process.env.NOTIF_REMETENTE || 'Mirsui <noreply@mirsui.com>')
  const limiteDia = Number(process.env.NOTIF_LIMITE_DIA) || 80

  let entregando = false
  const entregar = () => {
    if (entregando) return
    entregando = true
    entregarNotificacoes({ db, enviar, site, limiteDia, log })
      .catch((err) => log.error({ err }, 'Avisos: entrega falhou'))
      .finally(() => {
        entregando = false
      })
  }
  setInterval(entregar, 30_000).unref()
  setTimeout(entregar, 10_000).unref()

  let semanaGerada: string | null = null
  const conferirResumo = () => {
    const agora = agoraEmSaoPaulo()
    if (semanaGerada === agora.semana) return
    if (!horaDoResumo(agora, rodadaEmCurso())) return
    gerarResumoDaSemana(db, agora.semana)
      .then((r) => {
        semanaGerada = agora.semana
        if (!r.jaGerado) log.info(r, 'Avisos: resumo semanal dos saltos gerado')
        entregar()
      })
      .catch((err) => log.error({ err }, 'Avisos: resumo semanal falhou'))
  }
  // :37 fica longe do :07 da rede de segurança do Observatório
  cron.schedule('37 * * * *', conferirResumo, { timezone: FUSO, recoverMissedExecutions: true })
  setTimeout(conferirResumo, 90_000).unref()

  log.info({ site, limiteDia }, 'Avisos por e-mail ligados')
}
