-- Descoberta controlada de faixas semelhantes para o Observatório.
--
-- Cada faixa ativa pode servir como semente uma única vez. O backend consulta
-- o rádio do artista no Deezer, escolhe no máximo uma faixa ainda desconhecida
-- e grava a candidata junto com a linhagem. Os limites de crescimento ficam no
-- backend; o banco garante idempotência, atomicidade e rastreabilidade.

alter table public.observed_tracks
  add column if not exists recommendation_checked_at timestamptz,
  add column if not exists recommendation_parent_track_id text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'observed_tracks_recommendation_parent_fkey'
      and conrelid = 'public.observed_tracks'::regclass
  ) then
    alter table public.observed_tracks
      add constraint observed_tracks_recommendation_parent_fkey
      foreign key (recommendation_parent_track_id)
      references public.observed_tracks (deezer_track_id)
      on delete set null;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'observed_tracks_recommendation_not_self'
      and conrelid = 'public.observed_tracks'::regclass
  ) then
    alter table public.observed_tracks
      add constraint observed_tracks_recommendation_not_self
      check (
        recommendation_parent_track_id is null
        or recommendation_parent_track_id <> deezer_track_id
      );
  end if;
end $$;

-- Fila pequena e ordenada: somente sementes ativas ainda não processadas.
create index if not exists observed_tracks_recommendation_pending_idx
  on public.observed_tracks (added_at, deezer_track_id)
  where active and recommendation_checked_at is null;

-- PostgreSQL não indexa a coluna da FK automaticamente. Este índice também
-- atende futuras consultas de linhagem ("descoberta a partir de qual faixa?").
create index if not exists observed_tracks_recommendation_parent_idx
  on public.observed_tracks (recommendation_parent_track_id)
  where recommendation_parent_track_id is not null;

-- Insere as recomendações, o primeiro ponto histórico e a marca das sementes
-- na mesma transação. Se qualquer parte falhar, a semente continua pendente.
--
-- SECURITY INVOKER: quem chama é a service_role do job, que já possui a
-- permissão necessária. A função não precisa nem deve elevar privilégios.
create or replace function public.record_recommendation_expansion(
  p_rows jsonb,
  p_parent_ids text[]
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_novas integer := 0;
  v_pontos integer := 0;
  v_ligadas integer := 0;
  v_marcadas integer := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'p_rows precisa ser um array JSON';
  end if;

  -- Conta antes do upsert para o log distinguir candidata de faixa nova.
  select count(*)::integer
  into v_novas
  from (
    select distinct r->>'deezer_track_id' as deezer_track_id
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    where r->>'deezer_track_id' is not null
  ) e
  where not exists (
    select 1
    from public.observed_tracks o
    where o.deezer_track_id = e.deezer_track_id
  );

  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    select public.record_observations(p_rows) into v_pontos;

    with entrada as (
      select distinct on (deezer_track_id)
        r->>'deezer_track_id' as deezer_track_id,
        r->>'recommendation_parent_track_id' as parent_id
      from jsonb_array_elements(p_rows) as r
      where r->>'deezer_track_id' is not null
        and r->>'recommendation_parent_track_id' is not null
      order by deezer_track_id
    )
    update public.observed_tracks o
    set recommendation_parent_track_id = coalesce(
      o.recommendation_parent_track_id,
      e.parent_id
    )
    from entrada e
    where o.deezer_track_id = e.deezer_track_id;

    get diagnostics v_ligadas = row_count;
  end if;

  update public.observed_tracks
  set recommendation_checked_at = coalesce(recommendation_checked_at, now())
  where deezer_track_id = any(coalesce(p_parent_ids, array[]::text[]));

  get diagnostics v_marcadas = row_count;

  return jsonb_build_object(
    'novas', v_novas,
    'pontos', v_pontos,
    'ligadas', v_ligadas,
    'marcadas', v_marcadas
  );
end;
$$;

revoke all on function public.record_recommendation_expansion(jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.record_recommendation_expansion(jsonb, text[])
  to service_role;
