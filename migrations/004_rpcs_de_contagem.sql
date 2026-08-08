-- 004_rpcs_de_contagem.sql
-- Duas funções que substituem contagens feitas em JS, uma linha por vez.
--
-- Motivo 1 (landing): utils/homepageService.ts fazia 1 select + 3 counts POR
-- FAIXA — 25 idas ao banco para montar 8 cards. A landing é dinâmica (chama
-- auth.getUser(), então nunca cacheia), logo isso rodava em toda visita.
--
-- Motivo 2 (feed): mirsui-backend/src/routes/feed.ts puxava TODAS as linhas de
-- track_likes e track_comments das faixas do feed e contava no JS. Além do
-- tráfego, o PostgREST corta a resposta em 1000 linhas por padrão — passando de
-- mil likes a faixa mostrava número errado, sem erro nenhum.
--
-- security definer nas duas: track_likes e track_comments não aparecem em
-- supabase-rls-migration.sql. Se o RLS for ligado nelas depois sem policy de
-- select, uma função `invoker` passaria a devolver 0 caladamente. Como o dado
-- é público (a contagem já aparece na tela para qualquer visitante), definer
-- mantém o número certo independente disso.
--
-- Aplicar antes de subir o código que as consome — o código novo sem estas
-- funções quebra a landing e o feed.

-- ------------------------------------------------------------
-- 1. Faixas em alta da landing
-- ------------------------------------------------------------
-- Faz seleção, deduplicação e contagem numa varredura só.
--
-- Chave de deduplicação: o id do Spotify extraído de track_url, com fallback
-- para título+artista. O código antigo deduplicava por id do Spotify mas
-- contava por título+artista — duas chaves para a mesma coisa. O id é a chave
-- certa porque a mesma faixa salva por duas pessoas costuma vir com
-- artist_name diferente ("Daft Punk" vs "Daft Punk, Julian Casablancas").
-- Efeito colateral esperado: os números de total_claims mudam ao aplicar.
--
-- total_claims conta todos os salvamentos da faixa; o filtro de thumbnail vale
-- só para escolher a linha que representa a faixa no card (sem capa o card
-- fica vazio), não para a contagem.
create or replace function public.get_trending_tracks(p_limit integer default 8)
returns table (
  id              integer,
  track_title     text,
  artist_name     text,
  album_name      text,
  track_thumbnail text,
  track_url       text,
  popularity      integer,
  claimedat       timestamp,
  total_claims    bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with base as (
    select
      t.id, t.track_title, t.artist_name, t.album_name,
      t.track_thumbnail, t.track_url, t.popularity, t.claimedat,
      coalesce(
        nullif(regexp_replace(split_part(t.track_url, '?', 1), '^.*/', ''), ''),
        lower(coalesce(t.track_title, '')) || '-' || lower(coalesce(t.artist_name, ''))
      ) as faixa
    from public.tracks t
    where t.claimedat is not null
  ),
  total as (
    select b.faixa, count(*) as total_claims
    from base b
    group by b.faixa
  ),
  representante as (
    select distinct on (b.faixa)
      b.faixa, b.id, b.track_title, b.artist_name, b.album_name,
      b.track_thumbnail, b.track_url, b.popularity, b.claimedat
    from base b
    where b.track_thumbnail is not null
    order by b.faixa, b.popularity desc nulls last, b.claimedat desc
  )
  select
    r.id,
    r.track_title::text,
    r.artist_name::text,
    r.album_name::text,
    r.track_thumbnail::text,
    r.track_url::text,
    r.popularity,
    r.claimedat,
    t.total_claims
  from representante r
  join total t on t.faixa = r.faixa
  order by r.popularity desc nulls last, r.claimedat desc
  limit greatest(coalesce(p_limit, 8), 0);
$$;

grant execute on function public.get_trending_tracks(integer) to anon, authenticated;

-- ------------------------------------------------------------
-- 2. Contadores de like e comentário do feed
-- ------------------------------------------------------------
-- Uma chamada para as N faixas da página. As contagens acontecem no banco:
-- nenhuma linha de track_likes/track_comments trafega, e não existe teto de
-- 1000 linhas para esbarrar.
create or replace function public.get_track_interaction_counts(p_track_ids integer[])
returns table (
  track_id       integer,
  likes_count    bigint,
  comments_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    t.id as track_id,
    (select count(*) from public.track_likes    l where l.track_id = t.id) as likes_count,
    (select count(*) from public.track_comments c where c.track_id = t.id) as comments_count
  from unnest(coalesce(p_track_ids, '{}'::integer[])) as t(id);
$$;

grant execute on function public.get_track_interaction_counts(integer[]) to anon, authenticated;
