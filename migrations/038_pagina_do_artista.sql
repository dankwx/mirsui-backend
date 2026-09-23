-- A página pública de um artista do catálogo usa a medição que já temos.
-- Uma visita não deve pedir /artist, /top e /albums ao Deezer: robôs percorrem
-- justamente artistas que ainda não passaram pelo cache do gateway.
--
-- A discografia aqui é a parte presente no Observatório. O banco ainda não
-- conhece foto, tipo de lançamento nem a discografia completa; a interface
-- identifica esta cobertura, em vez de atribuir esses dados ao Deezer.

create index if not exists observed_tracks_artista_rank_idx
  on public.observed_tracks (deezer_artist_id, last_rank desc nulls last, deezer_track_id)
  where active and deezer_artist_id is not null;

create or replace function public.get_artist_page(p_deezer_artist_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with artista as (
    select o.artist_name
    from public.observed_tracks o
    where o.deezer_artist_id = p_deezer_artist_id and o.active
    order by o.last_rank desc nulls last, o.deezer_track_id
    limit 1
  ),
  top as (
    select o.*
    from public.observed_tracks o
    where o.deezer_artist_id = p_deezer_artist_id and o.active
    order by o.last_rank desc nulls last, o.deezer_track_id
    limit 99
  ),
  album_representante as (
    select distinct on (o.deezer_album_id)
      o.deezer_album_id, o.album_name, o.cover_md5,
      max(o.release_date) over (partition by o.deezer_album_id) as release_date,
      o.last_rank, o.deezer_track_id
    from public.observed_tracks o
    where o.deezer_artist_id = p_deezer_artist_id and o.active
      and o.deezer_album_id is not null and o.album_name is not null
    order by o.deezer_album_id, o.last_rank desc nulls last, o.deezer_track_id
  ),
  albuns as (
    select * from album_representante
    order by release_date desc nulls last, album_name, deezer_album_id
    limit 100
  )
  select jsonb_build_object(
    'name', a.artist_name,
    -- discovery_artists guarda alguns nb_fan, mas é uma fila privada, sem
    -- SELECT para anon. A página não deve atravessar essa proteção.
    'nb_fan', null,
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deezer_track_id', t.deezer_track_id, 'isrc', t.isrc,
        'title', t.title, 'artist_name', t.artist_name,
        'deezer_artist_id', t.deezer_artist_id,
        'deezer_album_id', t.deezer_album_id, 'album_name', t.album_name,
        'cover_md5', t.cover_md5, 'release_date', t.release_date,
        'duration_seconds', t.duration_seconds, 'last_popularity', t.last_popularity,
        'contributors', t.contributors
      ) order by t.last_rank desc nulls last, t.deezer_track_id)
      from top t
    ), '[]'::jsonb),
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deezer_album_id', l.deezer_album_id, 'album_name', l.album_name,
        'cover_md5', l.cover_md5, 'release_date', l.release_date
      ) order by l.release_date desc nulls last, l.album_name, l.deezer_album_id)
      from albuns l
    ), '[]'::jsonb)
  )
  from artista a;
$$;

revoke all on function public.get_artist_page(text) from public;
grant execute on function public.get_artist_page(text) to anon, authenticated, service_role;
