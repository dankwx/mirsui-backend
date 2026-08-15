/**
 * Quem pode abrir o painel.
 *
 * A lista mora aqui e não no banco de propósito: a service role key não
 * distingue um dono do outro — quem tem a chave lê tudo —, então a pergunta
 * "este token é do dono?" precisa ser respondida antes de a chave ser usada,
 * no mesmo processo que vai usá-la.
 *
 * `ADMIN_EMAILS` (separados por vírgula) substitui a lista inteira quando
 * estiver definida. Sem a variável, vale o padrão abaixo, que é o que roda hoje
 * em produção e em dev.
 */
const PADRAO = ['danielkondlatsch.p@gmail.com']

const doAmbiente = (process.env.ADMIN_EMAILS ?? '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean)

export const ADMIN_EMAILS = doAmbiente.length > 0 ? doAmbiente : PADRAO

/**
 * O e-mail vem de `request.user`, populado por `requireAuth` a partir de
 * `supabase.auth.getUser(token)` — ou seja, validado no Supabase, não lido de
 * um cookie. É por isso que dá para confiar nele como identidade.
 */
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false
  return ADMIN_EMAILS.includes(email.trim().toLowerCase())
}
