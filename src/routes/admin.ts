import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'
import { isAdmin } from '../lib/admins'

export default async function adminRoutes(app: FastifyInstance) {
  // ---- Estado geral do projeto, para o painel do dono ----
  //
  // O trabalho todo está em `admin_overview()` (migrations/019_painel_do_dono.sql):
  // uma função `security definer` que junta auth.users, achados, fichas,
  // Observatório e a linha do tempo num JSON só. Aqui sobra a porta.
  app.get('/admin/overview', { preHandler: requireAuth }, async (request, reply) => {
    if (!isAdmin(request.user.email)) {
      // 404 e não 403: quem não é dono não precisa descobrir que a rota existe.
      // O front faz o mesmo em /admin, pelo mesmo motivo.
      return reply.code(404).send({ error: 'Não encontrado' })
    }

    // `supabaseAdmin` é null quando SUPABASE_SERVICE_ROLE_KEY não está no
    // ambiente. Sem ela o RLS esconderia auth.users e as fichas dos outros, e a
    // resposta sairia com números silenciosamente errados — pior que um erro.
    if (!supabaseAdmin) {
      app.log.error('SUPABASE_SERVICE_ROLE_KEY ausente: /admin/overview não tem como ler o banco inteiro')
      return reply.code(503).send({ error: 'Painel indisponível: falta a service role key' })
    }

    const { data, error } = await supabaseAdmin.rpc('admin_overview')

    if (error) {
      app.log.error({ err: error }, 'Erro ao montar o painel')
      return reply.code(500).send({ error: 'Erro ao montar o painel' })
    }

    return reply.send(data)
  })
}
