-- 047_fechar_o_que_a_mudanca_abriu.sql
-- Fecha quatro portas pelas quais qualquer visitante lia e-mail de usuário, e
-- refaz os `revoke` que a mudança para a VPS apagou.
--
-- O QUE ACONTECEU
-- O dump que trouxe o banco para a VPS saiu com `--no-privileges`
-- (mirsui-web/docs/migracao-para-vps.md §3), e depois do restore foram
-- aplicados os grants padrão do Supabase: SELECT em toda tabela e EXECUTE em
-- toda função para `anon` e `authenticated`. O RLS veio junto e continuou
-- protegendo as LINHAS. O que não veio foi tudo que as migrations tinham
-- fechado por privilégio — e privilégio é o único jeito de fechar uma COLUNA
-- ou uma função `security definer`.
--
-- Medido em 16/11/2026 com a chave pública do site (a que vai no navegador):
--
--   1. `profiles.email` saía em `select=*`. A política é `using (true)`, que
--      é o certo para perfil público, mas ela vale para a linha inteira.
--   2. `get_user_followers` / `get_user_following` devolviam o e-mail de cada
--      seguidor na coluna `first_name` — e a página de perfil mandava isso no
--      HTML para qualquer visitante.
--   3. `get_user_profile(uuid)` devolvia o e-mail de `auth.users` de qualquer
--      id. Ninguém no site, no app ou no backend chama esta função.
--   4. `admin_overview()` — o painel do dono, com todos os e-mails — respondia
--      200 para anônimo. O revoke da 019 foi um dos que se perderam.
--
-- Roda numa transação só: ou fecha tudo, ou não muda nada.

begin;

-- ---------------------------------------------------------------------------
-- 1. profiles: o e-mail deixa de ser legível por anon e authenticated
-- ---------------------------------------------------------------------------
-- Privilégio por coluna. Quem precisa do próprio e-mail já o tem na sessão
-- (`user.email`); o backend lê `PUBLIC_PROFILE_FIELDS`, o site lê as mesmas
-- seis colunas, e o painel do dono usa service_role.
--
-- Consequência a saber: `select=*` em profiles passa a responder 401/403 para
-- anon e authenticated. É de propósito — coluna nova não fica pública por
-- esquecimento; precisa entrar na lista abaixo.

revoke select on public.profiles from anon, authenticated;
grant select (id, username, description, display_name, avatar_url, rating)
    on public.profiles to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Seguidores e seguindo: sem e-mail, e com os nomes certos
-- ---------------------------------------------------------------------------
-- As duas declaravam (id, first_name, last_name, avatar_url, username[, rating])
-- e preenchiam por POSIÇÃO com (id, email, username, avatar_url, display_name):
-- o e-mail saía como `first_name`, o username como `last_name`, e o
-- display_name como `username`. Quem consome (UserFollowers.tsx no site,
-- mapFollowUser no backend) sempre leu `username`, `display_name`,
-- `avatar_url` e `rating` — então, além do vazamento, o link de cada seguidor
-- apontava para /user/<display_name>, que não existe.
--
-- Mudar as colunas de saída exige drop: `create or replace` não troca o tipo
-- de retorno.

drop function if exists public.get_user_followers(uuid);
drop function if exists public.get_user_following(uuid);

create function public.get_user_followers(user_uuid uuid)
returns table (id uuid, username text, display_name text, avatar_url text, rating integer)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_url, p.rating
  from public.profiles p
  join public.followers f on p.id = f.follower_id
  where f.following_id = user_uuid;
$$;

create function public.get_user_following(user_uuid uuid)
returns table (id uuid, username text, display_name text, avatar_url text, rating integer)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.username, p.display_name, p.avatar_url, p.rating
  from public.profiles p
  join public.followers f on p.id = f.following_id
  where f.follower_id = user_uuid;
$$;

revoke all on function public.get_user_followers(uuid) from public;
revoke all on function public.get_user_following(uuid) from public;
grant execute on function public.get_user_followers(uuid) to anon, authenticated, service_role;
grant execute on function public.get_user_following(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. As funções que são só do backend voltam a ser só do backend
-- ---------------------------------------------------------------------------
-- A lista é a soma dos `revoke ... from public, anon, authenticated` de todas
-- as migrations (009 a 044), mais `get_user_profile`, que nunca teve revoke.
-- Todas são chamadas com a service_role (jobs do Observatório, painel do dono,
-- semeadura). Refazer o revoke em quem já estava fechado não muda nada.
--
-- O laço vai pelo nome e pega todas as assinaturas: várias destas mudaram de
-- argumentos ao longo das migrations, e uma sobrecarga velha esquecida aberta
-- é exatamente o tipo de coisa que este arquivo existe para não deixar.

do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_catalog.pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        'admin_overview', 'admin_catalogo_por_dia', 'get_user_profile',
        'seed_backdate_user',
        'record_observations', 'deactivate_observed_tracks', 'mark_isrc_checked',
        'record_spotify_ids', 'promote_saved_observed_tracks',
        'refresh_observatory_cadence', 'observatory_measurement_queue',
        'observatory_queue_size',
        'discovery_artist_queue', 'discovery_frontier_size',
        'discovery_source_report', 'record_album_expansion',
        'record_recommendation_expansion',
        'data_do_deezer', 'album_details_queue_size', 'album_details_queue',
        'record_album_details',
        'artist_details_due', 'artist_details_queue_size',
        'artist_details_queue', 'record_artist_details',
        'record_artist_similarity', 'rebuild_artist_pairs',
        'rebuild_artist_neighbors'
      ])
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- A 028: recolher ficha exige sessão (a função filtra por auth.uid()).
revoke execute on function public.collect_stake(uuid) from public, anon;

commit;

-- As duas funções de seguidores mudaram de formato: o PostgREST relê o esquema.
notify pgrst, 'reload schema';
