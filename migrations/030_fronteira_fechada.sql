-- 030_fronteira_fechada.sql
-- Liga RLS em `public.discovery_artists`, a única tabela do banco que ficou sem.
--
-- O PROBLEMA
-- O alerta de segurança do Supabase de 23/08/2026 (`rls_disabled_in_public`)
-- aponta uma tabela: a fronteira da caminhada, criada pela 026 em 16/08. O
-- `create table` foi escrito e o `enable row level security` não — as outras
-- dezesseis tabelas de `public` têm.
--
-- Sem RLS valem os grants padrão do Supabase, que dão SELECT, INSERT, UPDATE e
-- DELETE a `anon` e `authenticated` em todas as colunas. A anon key está no
-- bundle JS do site, então "anon" aqui quer dizer qualquer pessoa com o
-- endereço do projeto. Reproduzido antes desta migration, com a chave do
-- `.env.local` do front:
--
--   GET /rest/v1/discovery_artists?select=deezer_artist_id,artist_name,nb_fan
--   -> 200, com as linhas.
--
-- Ler nunca foi o risco: são metadados públicos da Deezer (id, nome, nº de fãs)
-- e a política editorial do que a descoberta persegue, o que não é segredo.
-- Escrever era, e de três maneiras, todas silenciosas:
--
--   1. DELETE — apaga a fronteira. A caminhada recomeça do zero, e a única
--      coisa que gritaria é `discovery_frontier_size()` marcando 0 no log.
--   2. PATCH `{"exhausted": true}` — pior que apagar. As linhas continuam lá,
--      a fila (`discovery_artist_queue`, que filtra `not exhausted`) devolve
--      vazio e a descoberta morre parecendo viva.
--   3. POST — insere id de artista que não existe. Aí a conta é a de sempre:
--      o orçamento da noite é em REQUISIÇÃO, não em byte, e cada id plantado
--      queima um `/artist/{id}/albums` da cota antes de dar em nada.
--
-- Auditoria antes desta migration, com o buraco aberto por nove dias: 75 linhas,
-- 31 exauridas, todo id numérico, toda linha com `parent_artist_id`, `depth` = 1
-- em todas, `nb_fan` entre 20 e 45.912 e `first_seen_at` de 16/08 06:10 a 25/08
-- 08:03 — o passo diário do job, sem buraco nem salto. Nada foi tocado. Mesma
-- conclusão da 018: estava aberto e não foi usado.
--
-- O QUE MUDA
-- RLS ligado e NENHUMA policy. É de propósito, e é diferente do que a 009 e a
-- 002 fizeram com `observed_tracks`, `track_popularity_history` e
-- `youtube_cache`: aquelas têm `select using (true)` porque o site as lê. Esta
-- ninguém lê fora do banco — `grep discovery_artists` no front não acha nada, e
-- o job só a alcança pelas quatro funções da 026, todas SECURITY INVOKER e
-- todas já com `revoke all ... from public, anon, authenticated`. Tabela sem
-- policy é tabela que só existe para quem tem `bypassrls`.
--
-- Os grants saem junto, como na 018. RLS sozinha já bastaria; o revoke é para
-- que uma policy escrita por reflexo daqui a seis meses não reabra a escrita
-- sem que alguém decida reabrir também o grant.
--
-- `service_role` tem `bypassrls` e mantém os grants: o job da descoberta não é
-- afetado.

alter table public.discovery_artists enable row level security;

revoke all on public.discovery_artists from anon, authenticated;

comment on table public.discovery_artists is
  'Fronteira da descoberta por álbum: artistas alcançados via /artist/{id}/related e o quanto da discografia de cada um já foi colhido. Ver migration 026. RLS ligada e sem policy desde a 030: só service_role enxerga.';

-- Conferir o estado final:
--
--   select relrowsecurity from pg_class
--    where oid = 'public.discovery_artists'::regclass;             -- t
--
--   select count(*) from pg_policies
--    where schemaname = 'public' and tablename = 'discovery_artists';  -- 0
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'discovery_artists'
--      and grantee in ('anon', 'authenticated');                   -- 0 linhas
--
-- E, de fora, com a anon key do bundle:
--
--   GET /rest/v1/discovery_artists?select=deezer_artist_id  -> 401/permission denied
