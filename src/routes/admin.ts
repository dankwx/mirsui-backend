import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '../lib/supabase'
import { requireAuth } from '../plugins/auth'
import { isAdmin } from '../lib/admins'
import { trocarFoto, apagarUsada, contarPool, PoolVazio, AVATAR_BUCKET } from '../seed/imagens'

const SEED_PAGE_LIMIT = 50

/**
 * A porta comum das rotas do dono. Devolve o cliente com service role, ou null
 * depois de já ter respondido:
 *   - 404 (e não 403) para quem não é dono: quem não é não precisa descobrir
 *     que a rota existe. O front faz o mesmo em /admin, pelo mesmo motivo.
 *   - 503 quando `supabaseAdmin` é null (SUPABASE_SERVICE_ROLE_KEY ausente).
 *     Sem ela o RLS esconderia auth.users, as fichas dos outros e a
 *     `seeded_profiles` inteira, e a resposta sairia silenciosamente errada —
 *     pior que um erro.
 */
function porta(app: FastifyInstance, request: FastifyRequest, reply: FastifyReply): SupabaseClient | null {
  if (!isAdmin(request.user.email)) {
    reply.code(404).send({ error: 'Não encontrado' })
    return null
  }
  if (!supabaseAdmin) {
    app.log.error(`SUPABASE_SERVICE_ROLE_KEY ausente: ${request.url} não tem como ler o banco inteiro`)
    reply.code(503).send({ error: 'Painel indisponível: falta a service role key' })
    return null
  }
  return supabaseAdmin
}

/**
 * A data de entrada (backdatada pela `seed_backdate_user`) mora em
 * `auth.users`, que o supabase-js não lê por `.from()`. A lista de usuários do
 * GoTrue é a porta: percorre as páginas até achar todos os ids pedidos. Com
 * poucas centenas de contas isso é uma ou duas chamadas.
 */
async function datasDeEntrada(admin: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  const faltam = new Set(ids)
  const datas = new Map<string, string>()
  for (let page = 1; faltam.size > 0; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers: ${error.message}`)
    for (const u of data.users) {
      if (faltam.delete(u.id) && u.created_at) datas.set(u.id, u.created_at)
    }
    if (data.users.length === 0 || !data.nextPage) break
  }
  return datas
}

export default async function adminRoutes(app: FastifyInstance) {
  // ---- Estado geral do projeto, para o painel do dono ----
  //
  // O trabalho todo está em `admin_overview()` (migrations/019_painel_do_dono.sql):
  // uma função `security definer` que junta auth.users, achados, fichas,
  // Observatório e a linha do tempo num JSON só. Aqui sobra a porta.
  //
  // A curva do catálogo (`catalogo`) vem de uma segunda função,
  // `admin_catalogo_por_dia()` (migration 034), e é colada aqui: reescrever a
  // 019 inteira para acrescentar um CTE esconderia a mudança no diff. Para o
  // frontend continua sendo um JSON só.
  app.get('/admin/overview', { preHandler: requireAuth }, async (request, reply) => {
    const admin = porta(app, request, reply)
    if (!admin) return

    const [overview, catalogo] = await Promise.all([
      admin.rpc('admin_overview'),
      admin.rpc('admin_catalogo_por_dia')
    ])

    if (overview.error) {
      app.log.error({ err: overview.error }, 'Erro ao montar o painel')
      return reply.code(500).send({ error: 'Erro ao montar o painel' })
    }
    if (catalogo.error) {
      app.log.error({ err: catalogo.error }, 'Erro ao montar a curva do catálogo')
      return reply.code(500).send({ error: 'Erro ao montar o painel' })
    }

    return reply.send({ ...overview.data, catalogo: catalogo.data })
  })

  // ---- Perfis semeados (docs/plano-semeadura-de-perfis.md, §7) ----
  //
  // O script `seed:perfis` cria; estas rotas só listam, trocam foto e apagam.
  // `seeded_profiles` tem RLS sem policy (migration 033): só a service role a
  // lê, e é ela que diz quais ids são semeados. As rotas de escrita abaixo
  // exigem que o id esteja lá — a troca de foto e o DELETE nunca alcançam um
  // usuário real, mesmo com a chave que poderia.

  // Lista paginada: quem está no ar, com qual JPEG, de que lote, quantas fichas.
  // Duas consultas em vez de um count embutido no PostgREST: 50 perfis com 1–3
  // fichas cada é um `in()` de 50 ids, e não depende de agregação habilitada.
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/admin/seed/profiles',
    { preHandler: requireAuth },
    async (request, reply) => {
      const admin = porta(app, request, reply)
      if (!admin) return

      const limit = Math.min(Math.max(Number(request.query.limit) || SEED_PAGE_LIMIT, 1), SEED_PAGE_LIMIT)
      const page = Math.max(Math.floor(Number(request.query.page) || 1), 1)
      const offset = (page - 1) * limit

      const { data: rows, error, count } = await admin
        .from('seeded_profiles')
        .select('profile_id, image_file, batch, created_at, profiles!inner(username, display_name, avatar_url)', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (error) {
        app.log.error({ err: error }, 'Erro ao listar perfis semeados')
        return reply.code(500).send({ error: 'Erro ao listar perfis semeados' })
      }

      const semeados = (rows ?? []) as unknown as Array<{
        profile_id: string
        image_file: string
        batch: string
        created_at: string
        profiles: { username: string | null; display_name: string | null; avatar_url: string | null }
      }>
      const ids = semeados.map(s => s.profile_id)

      const fichas = new Map<string, number>()
      if (ids.length > 0) {
        const { data: tracks, error: erroTracks } = await admin
          .from('tracks')
          .select('user_id')
          .in('user_id', ids)
        if (erroTracks) {
          app.log.error({ err: erroTracks }, 'Erro ao contar fichas dos semeados')
          return reply.code(500).send({ error: 'Erro ao contar fichas dos semeados' })
        }
        for (const t of tracks ?? []) fichas.set(t.user_id, (fichas.get(t.user_id) ?? 0) + 1)
      }

      let entradas = new Map<string, string>()
      try {
        entradas = await datasDeEntrada(admin, ids)
      } catch (err) {
        // Sem a data de entrada a lista ainda serve; cai na data da semeadura.
        app.log.warn({ err }, 'Não consegui ler as datas de entrada em auth.users')
      }

      let pool = 0
      try {
        pool = await contarPool()
      } catch (err) {
        app.log.warn({ err }, 'Não consegui contar o pool de fotos')
      }

      return reply.send({
        profiles: semeados.map(s => ({
          id: s.profile_id,
          username: s.profiles.username,
          display_name: s.profiles.display_name,
          avatar_url: s.profiles.avatar_url,
          image_file: s.image_file,
          batch: s.batch,
          created_at: entradas.get(s.profile_id) ?? s.created_at,
          fichas: fichas.get(s.profile_id) ?? 0
        })),
        total: count ?? semeados.length,
        page,
        limit,
        pool
      })
    }
  )

  // Troca a foto por outra do pool (src/seed/imagens.ts). O objeto no Storage
  // é o mesmo; só o `?v=` da URL muda, e `GET /profiles/:id/avatar` já segue.
  app.post<{ Params: { id: string } }>(
    '/admin/seed/profiles/:id/trocar-foto',
    { preHandler: requireAuth },
    async (request, reply) => {
      const admin = porta(app, request, reply)
      if (!admin) return

      try {
        const foto = await trocarFoto(admin, request.params.id)
        return reply.send(foto)
      } catch (err) {
        if (err instanceof PoolVazio) return reply.code(409).send({ error: 'Acabaram as fotos no pool' })
        if (err instanceof Error && err.message === 'perfil não é semeado') {
          return reply.code(404).send({ error: 'Perfil semeado não encontrado' })
        }
        app.log.error({ err, profileId: request.params.id }, 'Erro ao trocar a foto do semeado')
        return reply.code(500).send({ error: 'Erro ao trocar a foto' })
      }
    }
  )

  // Apaga um semeado que saiu estranho. É a limpeza da migration 033 para um
  // id só: o DELETE em auth.users leva profile, fichas, follows e a linha de
  // controle na cascata; a foto sai de `usadas/` e o objeto do Storage some.
  app.delete<{ Params: { id: string } }>(
    '/admin/seed/profiles/:id',
    { preHandler: requireAuth },
    async (request, reply) => {
      const admin = porta(app, request, reply)
      if (!admin) return
      const { id } = request.params

      const { data: semeado, error } = await admin
        .from('seeded_profiles')
        .select('image_file')
        .eq('profile_id', id)
        .maybeSingle()
      if (error) {
        app.log.error({ err: error, profileId: id }, 'Erro ao ler seeded_profiles')
        return reply.code(500).send({ error: 'Erro ao apagar o perfil' })
      }
      if (!semeado) return reply.code(404).send({ error: 'Perfil semeado não encontrado' })

      const { error: erroApagar } = await admin.auth.admin.deleteUser(id)
      if (erroApagar) {
        app.log.error({ err: erroApagar, profileId: id }, 'Erro ao apagar o usuário semeado')
        return reply.code(500).send({ error: 'Erro ao apagar o perfil' })
      }

      // Depois do usuário ir embora nada abaixo é motivo para responder erro:
      // o perfil já não existe, o resto é faxina.
      await apagarUsada(semeado.image_file).catch(err =>
        app.log.warn({ err, arquivo: semeado.image_file }, 'Usuário apagado, mas a foto ficou em usadas/')
      )
      const { error: erroStorage } = await admin.storage
        .from(AVATAR_BUCKET)
        .remove([`${id}/profile-picture`])
      if (erroStorage) app.log.warn({ err: erroStorage, profileId: id }, 'Usuário apagado, mas o avatar ficou no Storage')

      return reply.send({ success: true, id, image_file: semeado.image_file })
    }
  )
}
