-- Preserva o álbum enviado por charts, descoberta e consultas individuais.
-- Reaplica a função da 025 com apenas esse metadado adicional. Não altera
-- cálculo de rank, histórico por delta, cadência ou regras de acesso.
-- Aplicar atomicamente com psql --single-transaction -v ON_ERROR_STOP=1.

create or replace function public.record_observations(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_pontos integer;
begin
  with entrada as (
    -- distinct on: a mesma faixa aparece no chart global e no de gênero. Sem
    -- deduplicar, o ON CONFLICT DO UPDATE aborta com "cannot affect row a
    -- second time".
    select distinct on (deezer_track_id) *
    from (
      select
        r->>'deezer_track_id'    as deezer_track_id,
        r->>'deezer_artist_id'   as deezer_artist_id,
        nullif(r->>'deezer_album_id', '') as deezer_album_id,
        r->>'isrc'               as isrc,
        r->>'title'              as title,
        r->>'artist_name'        as artist_name,
        r->>'album_name'         as album_name,
        r->>'cover_md5'          as cover_md5,
        r->>'genre'              as genre,
        r->>'source_list'        as source_list,
        (r->>'rank')::integer    as rank,
        (r->>'popularity')::integer as popularity
      from jsonb_array_elements(p_rows) as r
    ) bruto
    where deezer_track_id is not null
      and title is not null
      and artist_name is not null
      and rank is not null
  ),
  -- Estado ANTES da rodada. Todas as CTEs enxergam o mesmo snapshot, então isto
  -- continua valendo mesmo com a CTE `catalogo` abaixo escrevendo na tabela.
  anterior as (
    select
      e.deezer_track_id,
      o.last_checked_at as medido_em,
      u.rank            as rank_gravado
    from entrada e
    left join public.observed_tracks o on o.deezer_track_id = e.deezer_track_id
    left join lateral (
      select h.rank
      from public.track_popularity_history h
      where h.track_uri = 'deezer:track:' || e.deezer_track_id
        and h.rank is not null
      order by h.recorded_at desc
      limit 1
    ) u on true
  ),
  mudanca as (
    select
      e.*,
      a.rank_gravado,
      -- `is distinct from` e não `<>`: faixa nova tem rank_gravado nulo e precisa
      -- entrar. Com `<>` o NULL faria a linha sumir e nenhuma faixa nova teria
      -- primeiro ponto.
      (a.rank_gravado is distinct from e.rank) as mudou,
      case
        when a.medido_em is null then null
        else greatest(
               ((now() at time zone 'UTC')::date - (a.medido_em at time zone 'UTC')::date),
               1
             )::smallint
      end as gap
    from entrada e
    join anterior a on a.deezer_track_id = e.deezer_track_id
  ),
  catalogo as (
    insert into public.observed_tracks as o (
      deezer_track_id, deezer_artist_id, deezer_album_id, isrc, title, artist_name, album_name,
      cover_md5, genre, source_list, origin_list,
      first_rank, first_popularity, last_rank, last_popularity, last_checked_at,
      last_change_at, prev_rank
    )
    select
      m.deezer_track_id, m.deezer_artist_id, m.deezer_album_id, m.isrc, m.title, m.artist_name,
      m.album_name, m.cover_md5, m.genre, m.source_list, m.source_list,
      m.rank, m.popularity, m.rank, m.popularity, now(),
      -- Faixa nova: o primeiro ponto é uma mudança por definição, e não há rank
      -- anterior. Faixa existente sem mudança entra aqui com NULL, que é o sinal
      -- que o ON CONFLICT lê para preservar o valor antigo.
      case when m.mudou then now() else null end,
      m.rank_gravado
    from mudanca m
    on conflict (deezer_track_id) do update set
      last_rank       = excluded.last_rank,
      last_popularity = excluded.last_popularity,
      last_checked_at = now(),
      active          = true,
      -- metadado só melhora, nunca piora: se veio nulo agora, mantém o que tinha
      deezer_album_id = coalesce(excluded.deezer_album_id, o.deezer_album_id),
      isrc            = coalesce(excluded.isrc, o.isrc),
      genre           = coalesce(excluded.genre, o.genre),
      cover_md5       = coalesce(excluded.cover_md5, o.cover_md5),
      album_name      = coalesce(excluded.album_name, o.album_name),
      -- origem é da primeira vez e nunca mais; source_list é da promoção, não
      -- daqui — reescrevê-lo devolveria a faixa salva para 'chart:81' toda noite
      origin_list     = coalesce(o.origin_list, excluded.origin_list),
      last_change_at  = coalesce(excluded.last_change_at, o.last_change_at),
      prev_rank       = case
                          when excluded.last_change_at is not null then excluded.prev_rank
                          else o.prev_rank
                        end
    returning 1
  ),
  historico as (
    insert into public.track_popularity_history
      (track_uri, popularity, rank, source, measured_gap_days)
    select 'deezer:track:' || m.deezer_track_id, m.popularity, m.rank, 'deezer', m.gap
    from mudanca m
    where m.mudou
    on conflict do nothing
    returning 1
  )
  -- CTEs que escrevem rodam mesmo sem serem referenciadas, mas as duas entram na
  -- conta para deixar isso explícito.
  select (select count(*) from historico) + 0 * (select count(*) from catalogo)
  into v_pontos;

  return v_pontos;
end $$;

comment on function public.record_observations(jsonb) is
  'Grava catálogo + histórico. O histórico só recebe linha quando o rank difere do último ponto gravado (021), com a largura da janela de medição em measured_gap_days (025). Retorna o número de MUDANÇAS gravadas, não de medições.';

revoke all on function public.record_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_observations(jsonb) to service_role;

-- Recuperação sem API: somente origem de álbum estritamente válida, e apenas
-- quando a coluna está vazia. origin_list é a procedência imutável; source_list
-- só serve como fallback para registros antigos que ainda não têm origem.
-- Não altera last_checked_at, rank, histórico ou uma associação já existente.
update public.observed_tracks
set deezer_album_id = split_part(coalesce(origin_list, source_list), ':', 2)
where (deezer_album_id is null or deezer_album_id = '')
  and coalesce(origin_list, source_list) ~ '^album:[1-9][0-9]*$';
