-- 014_ponte_spotify.sql
-- Fecha a ponte: id do Deezer -> ISRC -> id do Spotify.
--
-- MOTIVO
-- As páginas de faixa do site são endereçadas por id do Spotify
-- (/track/[spotifyId]) e renderizam para QUALQUER faixa válida — não dependem
-- de ninguém ter salvado. Mas o Observatório mede por id do Deezer, e os dois
-- identificadores não se convertem: cada plataforma inventa o seu.
--
-- Sem esta coluna, a Pilha não tinha para onde apontar e mandava tudo para
-- /claimtrack, que era o link genérico herdado do mock. Pior: as 2.602 faixas
-- medidas são páginas órfãs — existem, estão públicas, e nada no site leva até
-- elas.
--
-- O ISRC (migration 010) é o meio do caminho; aqui vem a outra metade, via
-- /search?q=isrc:XXXX na API do Spotify.
--
-- POR QUE A MARCA DE "JÁ TENTEI"
-- Mesma lição do ISRC: sem `spotify_checked_at`, a fila seria "está sem id do
-- Spotify" e toda faixa que não existe no Spotify voltaria para a fila todas as
-- noites, para sempre, travando o avanço. Aqui a taxa de não-encontrado deve ser
-- maior que a do ISRC: src/lib/spotify.ts busca com `market=BR`, então faixa
-- indisponível no Brasil não resolve — o que é o comportamento certo para um
-- produto brasileiro (não adianta linkar o que o visitante não pode tocar).
--
-- Para forçar nova tentativa:
--   update public.observed_tracks set spotify_checked_at = null
--   where spotify_track_id is null;

alter table public.observed_tracks
  add column if not exists spotify_track_id text,
  add column if not exists spotify_checked_at timestamptz;

-- Fila da etapa. Índice parcial sobre um conjunto que só encolhe.
create index if not exists observed_tracks_spotify_pendente_idx
  on public.observed_tracks (added_at)
  where active and spotify_track_id is null and spotify_checked_at is null;

-- Grava o resultado da rodada. Aceita linhas sem id: elas só ganham a marca de
-- tentativa, que é o que as tira da fila.
create or replace function public.record_spotify_ids(p_rows jsonb)
returns integer
language plpgsql
as $$
declare
  v_com_id integer;
begin
  with entrada as (
    select distinct on (deezer_track_id)
      r->>'deezer_track_id'  as deezer_track_id,
      r->>'spotify_track_id' as spotify_track_id
    from jsonb_array_elements(p_rows) as r
    where r->>'deezer_track_id' is not null
  ),
  atualizadas as (
    update public.observed_tracks o
    set spotify_checked_at = now(),
        -- Formato do id do Spotify: 22 caracteres base62. Qualquer coisa fora
        -- disso entra como null em vez de virar link quebrado.
        spotify_track_id = case
          when e.spotify_track_id ~ '^[A-Za-z0-9]{22}$' then e.spotify_track_id
          else o.spotify_track_id
        end
    from entrada e
    where o.deezer_track_id = e.deezer_track_id
    returning case when o.spotify_track_id is not null then 1 else 0 end as ok
  )
  select coalesce(sum(ok), 0) into v_com_id from atualizadas;
  return v_com_id;
end $$;

revoke all on function public.record_spotify_ids(jsonb) from public, anon, authenticated;
grant execute on function public.record_spotify_ids(jsonb) to service_role;

-- A Pilha passa a devolver o id do Spotify junto, para os cards e a lista
-- linkarem direto em /track/<id>. Quem ainda não resolveu vem null, e a
-- interface renderiza a linha sem link em vez de mandar para lugar errado.
create or replace function public.get_pile_tracks(p_por_genero integer default 6)
returns jsonb
language sql
stable
as $$
  with canonicas as (
    select distinct on (o.isrc) o.*
    from public.observed_tracks o
    where o.active
      and o.cover_md5 is not null
      and o.last_rank is not null
      and o.isrc is not null
    order by o.isrc, o.last_rank desc
  ),
  amostra as (
    select c.*,
           row_number() over (
             partition by coalesce(c.genre, 'outros')
             order by md5(c.deezer_track_id)
           ) as n
    from canonicas c
  ),
  escolhidas as (
    select a.*, ntile(3) over (order by a.last_rank) as terco
    from amostra a
    where a.n <= p_por_genero
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',         e.deezer_track_id,
        'spotify_id', e.spotify_track_id,
        'title',      e.title,
        'artist',     e.artist_name,
        'md5',        e.cover_md5,
        'genre',      coalesce(e.genre, 'outros'),
        'heat',       case e.terco when 3 then 'topo' when 2 then 'meio' else 'subsolo' end,
        'audiencia',  coalesce(e.last_popularity, 0)
      )
      order by e.last_rank desc
    ),
    '[]'::jsonb
  )
  from escolhidas e;
$$;

grant execute on function public.get_pile_tracks(integer) to anon, authenticated;
