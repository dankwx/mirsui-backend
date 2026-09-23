-- A página de artista consulta até 99 gravações. O filtro PostgREST em GET
-- repetia cada ISRC na URL e o proxy de db.mirsui.com devolvia 502
-- ("upstream sent too big header"). Uma RPC POST leva as chaves no corpo e
-- devolve a mesma lista de salvamentos numa única resposta.

create or replace function public.get_artist_claims(
  p_isrcs text[],
  p_uris text[],
  p_limite integer default 500
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id', c.user_id,
    'position', c.position,
    'claimedat', c.claimedat,
    'isrc', c.isrc,
    'track_uri', c.track_uri,
    'profiles', case when c.profile_id is null then null else jsonb_build_object(
      'username', c.username,
      'avatar_url', c.avatar_url,
      'display_name', c.display_name
    ) end
  ) order by c.claimedat asc nulls last, c.user_id), '[]'::jsonb)
  from (
    select t.user_id, t.position, t.claimedat, t.isrc, t.track_uri,
           p.id as profile_id, p.username, p.avatar_url, p.display_name
    from public.tracks t
    left join public.profiles p on p.id = t.user_id
    where t.isrc = any(coalesce(p_isrcs, '{}'::text[]))
       or t.track_uri = any(coalesce(p_uris, '{}'::text[]))
    order by t.claimedat asc nulls last, t.user_id
    limit least(greatest(coalesce(p_limite, 500), 0), 500)
  ) c;
$$;

revoke all on function public.get_artist_claims(text[], text[], integer) from public;
grant execute on function public.get_artist_claims(text[], text[], integer)
  to anon, authenticated, service_role;
