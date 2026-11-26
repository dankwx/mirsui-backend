import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Email } from '../lib/email'
import type { NotificacaoParaEmail } from '../lib/modelosDeEmail'
import { agoraEmSaoPaulo, entregarNotificacoes, horaDoResumo } from './notificacoes'

test('semana ISO e dia em São Paulo, como o to_char(IYYY-IW) do banco', () => {
  // quinta 26/11/2026, meio-dia em SP
  assert.deepEqual(agoraEmSaoPaulo(new Date('2026-11-26T15:00:00Z')), {
    diaDaSemana: 4,
    hora: 12,
    semana: '2026-48',
  })
  // segunda 30/11, 07:00 em SP
  assert.deepEqual(agoraEmSaoPaulo(new Date('2026-11-30T10:00:00Z')), {
    diaDaSemana: 1,
    hora: 7,
    semana: '2026-49',
  })
  // 02:00 UTC de segunda ainda é domingo 23:00 em SP
  assert.deepEqual(agoraEmSaoPaulo(new Date('2026-11-30T02:00:00Z')), {
    diaDaSemana: 7,
    hora: 23,
    semana: '2026-48',
  })
  // 2026 tem 53 semanas ISO; 1º/1/2027 (sexta) ainda é a 53 de 2026
  assert.equal(agoraEmSaoPaulo(new Date('2027-01-01T15:00:00Z')).semana, '2026-53')
  assert.equal(agoraEmSaoPaulo(new Date('2027-01-04T15:00:00Z')).semana, '2027-01')
})

test('o resumo espera a rodada da segunda, e a terça cobre a segunda perdida', () => {
  assert.equal(horaDoResumo({ diaDaSemana: 1, hora: 6 }, false), false)
  assert.equal(horaDoResumo({ diaDaSemana: 1, hora: 7 }, true), false)
  assert.equal(horaDoResumo({ diaDaSemana: 1, hora: 9 }, false), true)
  assert.equal(horaDoResumo({ diaDaSemana: 2, hora: 0 }, true), true)
  assert.equal(horaDoResumo({ diaDaSemana: 3, hora: 12 }, false), false)
  assert.equal(horaDoResumo({ diaDaSemana: 7, hora: 12 }, false), false)
})

// Um Supabase de mentira com só o que a entrega usa.
function bancoFalso(opts: { enviadas24h: number; lote: NotificacaoParaEmail[] }) {
  const chamadas: { rpc: string; args: Record<string, unknown> }[] = []
  const consulta = {
    select: () => consulta,
    eq: () => consulta,
    gte: async () => ({ count: opts.enviadas24h, error: null }),
  }
  const db = {
    from: () => consulta,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      chamadas.push({ rpc: nome, args })
      if (nome === 'reivindicar_notificacoes') return { data: opts.lote, error: null }
      return { data: null, error: null }
    },
  }
  return { db: db as unknown as SupabaseClient, chamadas }
}

const log = { info() {}, warn() {}, error() {} }

const seguidor: NotificacaoParaEmail = {
  id: 7,
  tipo: 'seguidor',
  dados: {},
  tentativas: 1,
  email: 'b@exemplo.dev',
  token: '11111111-2222-4333-8444-555555555555',
  destino_username: 'b',
  ator_username: 'ana',
  ator_nome: 'Ana',
  ator_avatar: null,
  ator_bio: null,
  ator_faixas: 3,
}

test('entrega: manda, fecha cada aviso e põe o descadastro de um clique', async () => {
  const quebrado = { ...seguidor, id: 8, ator_username: null }
  const { db, chamadas } = bancoFalso({ enviadas24h: 0, lote: [seguidor, quebrado] })
  const enviados: Email[] = []
  const r = await entregarNotificacoes({
    db,
    enviar: async (e) => void enviados.push(e),
    site: 'https://www.mirsui.com',
    limiteDia: 80,
    log,
    pausaMs: 0,
  })

  assert.deepEqual(r, { enviadas: 1, falhas: 1, semVaga: false })
  assert.equal(enviados.length, 1)
  assert.equal(enviados[0].para, 'b@exemplo.dev')
  assert.equal(enviados[0].idempotencia, 'mirsui-notificacao-7')
  assert.equal(
    enviados[0].cabecalhos?.['List-Unsubscribe'],
    '<https://www.mirsui.com/api/emails/sair?token=11111111-2222-4333-8444-555555555555&tipo=seguidor>'
  )
  assert.equal(enviados[0].cabecalhos?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click')

  const fechados = chamadas.filter((c) => c.rpc === 'concluir_notificacao').map((c) => c.args)
  assert.deepEqual(fechados[0], { p_id: 7, p_erro: null })
  assert.equal(fechados[1].p_id, 8)
  assert.match(String(fechados[1].p_erro), /sem modelo/)
})

test('entrega: erro do Resend volta para a fila com o motivo', async () => {
  const { db, chamadas } = bancoFalso({ enviadas24h: 0, lote: [seguidor] })
  const r = await entregarNotificacoes({
    db,
    enviar: async () => {
      throw new Error('Resend 429: rate limit')
    },
    site: 'https://www.mirsui.com',
    limiteDia: 80,
    log,
    pausaMs: 0,
  })
  assert.deepEqual(r, { enviadas: 0, falhas: 1, semVaga: false })
  const fim = chamadas.find((c) => c.rpc === 'concluir_notificacao')
  assert.deepEqual(fim?.args, { p_id: 7, p_erro: 'Resend 429: rate limit' })
})

test('entrega: o teto diário segura o lote', async () => {
  const cheio = bancoFalso({ enviadas24h: 80, lote: [seguidor] })
  const r = await entregarNotificacoes({
    db: cheio.db,
    enviar: async () => assert.fail('não devia enviar'),
    site: 'https://www.mirsui.com',
    limiteDia: 80,
    log,
  })
  assert.equal(r.semVaga, true)
  assert.equal(cheio.chamadas.length, 0)

  const quase = bancoFalso({ enviadas24h: 77, lote: [] })
  await entregarNotificacoes({ db: quase.db, enviar: async () => {}, site: 's', limiteDia: 80, log })
  assert.deepEqual(quase.chamadas[0], { rpc: 'reivindicar_notificacoes', args: { p_limite: 3 } })
})
