// Envio de e-mail pelo Resend, pela API HTTP.
//
// É a mesma conta que o GoTrue usa por SMTP para confirmação de cadastro e
// troca de senha (docs/migracao-para-vps.md, fase 3), com o domínio
// mirsui.com já verificado. O plano gratuito dá 3.000 e-mails por mês e 100
// por dia, e esses 100 são divididos com os e-mails de login: é por isso que
// os avisos têm um teto diário próprio, abaixo dos 100 (NOTIF_LIMITE_DIA).
//
// A API aceita 2 requisições por segundo; quem chama espaça os envios.

export interface Email {
  para: string
  assunto: string
  html: string
  texto: string
  cabecalhos?: Record<string, string>
  /**
   * Mesma chave = mesmo e-mail por 24 h no Resend. É o que torna seguro
   * reenviar um aviso que ficou preso em "enviando" quando o processo caiu
   * depois de o Resend aceitar.
   */
  idempotencia?: string
}

export type EnviarEmail = (email: Email) => Promise<void>

export function criarEnvioResend(
  apiKey: string,
  remetente: string,
  fetchImpl: typeof fetch = fetch
): EnviarEmail {
  return async (email) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    }
    if (email.idempotencia) headers['Idempotency-Key'] = email.idempotencia

    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        from: remetente,
        to: [email.para],
        subject: email.assunto,
        html: email.html,
        text: email.texto,
        headers: email.cabecalhos,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const corpo = await res.text().catch(() => '')
      throw new Error(`Resend ${res.status}: ${corpo.slice(0, 300)}`)
    }
  }
}
