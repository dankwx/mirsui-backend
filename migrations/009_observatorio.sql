-- 009_observatorio.sql
-- O Observatório: medição diária do catálogo, desacoplada dos usuários.
--
-- MOTIVO
-- O job de stakes (src/jobs/stakeSnapshot.ts) mede popularidade todo dia desde
-- 23/06/2026 — mas só das faixas que alguém fichou. Eram três. A coleta ficou
-- amarrada ao número de usuários, então um site sem usuários não acumula dado
-- nenhum, e é justamente o dado que traria os usuários.
--
-- Aqui a coleta passa a rodar sobre o catálogo inteiro, independente de qualquer
-- pessoa ter salvado a faixa. O valor está no TEMPO, não no volume: curva de
-- subida não tem backfill. Nenhuma API devolve "qual era o rank em março"; ou
-- você mediu naquele dia ou aquele ponto não existe. Cada dia que o job não roda
-- é um dia que não se recupera — por isso vale ligar mesmo incompleto.
--
-- O QUE ENTRA
--   1. observed_tracks           — o catálogo sob observação
--   2. track_popularity_history  — ganha `rank` (bruto) e chave de idempotência
--   3. record_observations()     — grava as duas coisas numa tacada só
--
-- CHAVE DE MEDIÇÃO
-- A medição é feita pelo id do Deezer, não do Spotify: o Deezer expõe `rank`
-- publicamente e sem chave, e o Spotify tirou `popularity` do ar. Como
-- track_popularity_history.track_uri é texto livre, as linhas do Observatório
-- entram como 'deezer:track:<id>' com source='deezer', convivendo com as
-- 'spotify:track:<id>' que já existiam. observed_tracks.isrc é a ponte para
-- casar com o Spotify quando a página de track precisar (mesmo caminho que
-- src/lib/deezer.ts já usa em resolveTrack).

-- ---------------------------------------------------------------------------
-- 1. Catálogo sob observação
-- ---------------------------------------------------------------------------

create table if not exists public.observed_tracks (
  deezer_track_id   text primary key,
  deezer_artist_id  text,
  isrc              text,
  title             text not null,
  artist_name       text not null,
  album_name        text,
  -- md5_image do Deezer: monta a capa em qualquer tamanho no CDN deles, sem
  -- guardar URL. Mesmo truque usado no snapshot da Pilha (utils/pileService.ts).
  cover_md5         text,
  genre             text,
  -- de onde a faixa entrou: 'chart:0', 'chart:116', 'acervo'. Serve para saber
  -- se o Observatório está enviesado para o que já é popular.
  source_list       text,

  -- first_* é a marca do dia em que a faixa entrou e nunca muda: é o que
  -- permite dizer "subiu N desde que começamos a medir".
  first_rank        integer,
  first_popularity  integer,
  last_rank         integer,
  last_popularity   integer,

  active            boolean not null default true,
  added_at          timestamptz not null default now(),
  last_checked_at   timestamptz
);

comment on table public.observed_tracks is
  'Faixas medidas diariamente pelo Observatório, independente de usuários. Ver migrations/009_observatorio.sql';

-- Fila do job: "quem não foi medido hoje, do mais antigo para o mais recente".
create index if not exists observed_tracks_fila_idx
  on public.observed_tracks (last_checked_at nulls first)
  where active;

create index if not exists observed_tracks_isrc_idx
  on public.observed_tracks (isrc)
  where isrc is not null;

alter table public.observed_tracks enable row level security;

-- Leitura pública: as páginas de faixa/artista e os rankings são abertos, e
-- precisam ler isto sem sessão. Escrita não tem policy nenhuma — só o job entra,
-- com a service role, que ignora RLS.
drop policy if exists "observed_tracks_select_public" on public.observed_tracks;
create policy "observed_tracks_select_public"
  on public.observed_tracks for select
  using (true);

-- ---------------------------------------------------------------------------
-- 2. Histórico: rank bruto + idempotência por dia
-- ---------------------------------------------------------------------------

-- `popularity` é o rank normalizado 0-100 por popScore() (src/lib/stakePoints.ts),
-- e a normalização é grosseira de propósito para os pontos: divide por 10.000,
-- então 107.970 e 117.000 viram 11 e 12. Para desenhar curva de subida isso
-- perde resolução demais. Guardamos os dois: `popularity` continua sendo o que
-- os Stakes consomem, `rank` é o número cru do Deezer.
alter table public.track_popularity_history
  add column if not exists rank integer;

-- A tabela já tinha 38 linhas de um backfill antigo (source='migration',
-- maio/2025 a junho/2026), e entre elas um par duplicado: a mesma faixa, no
-- mesmo dia, com a MESMA popularidade, gravada duas vezes com 32 min de
-- diferença. Não são duas medições, é a mesma medição repetida — então some com
-- a repetição antes de criar o índice único. Mantém a de menor id.
delete from public.track_popularity_history t
using public.track_popularity_history anterior
where t.track_uri = anterior.track_uri
  and (t.recorded_at at time zone 'UTC')::date = (anterior.recorded_at at time zone 'UTC')::date
  and t.id > anterior.id;

-- Idempotência: no máximo um ponto por faixa por dia. Com isto o job insere com
-- `on conflict do nothing` e rodar duas vezes no mesmo dia não duplica nada —
-- diferente do job de stakes, que faz um SELECT de checagem por faixa (N+1).
-- O cast usa 'UTC' explícito porque recorded_at::date sozinho depende do
-- timezone da sessão e não é imutável, o que o índice não aceita.
create unique index if not exists track_popularity_history_dia_idx
  on public.track_popularity_history (track_uri, ((recorded_at at time zone 'UTC')::date));

alter table public.track_popularity_history enable row level security;

drop policy if exists "track_popularity_history_select_public" on public.track_popularity_history;
create policy "track_popularity_history_select_public"
  on public.track_popularity_history for select
  using (true);

-- ---------------------------------------------------------------------------
-- 3. Gravação em lote
-- ---------------------------------------------------------------------------

-- Recebe um lote de medições e grava nas duas tabelas numa transação só.
--
-- Existe como função (e não como dois .upsert() do supabase-js) por três
-- motivos: (a) o upsert do cliente sobrescreveria first_rank/first_popularity a
-- cada rodada, apagando justamente a marca de entrada; (b) atualizar rank linha
-- a linha seriam milhares de idas ao banco por noite; (c) catálogo e histórico
-- precisam entrar juntos ou não entrar.
--
-- SECURITY INVOKER de propósito: quem chama é o job com service role, que já
-- ignora RLS. Não é concedida a anon/authenticated.
create or replace function public.record_observations(p_rows jsonb)
returns integer
language plpgsql
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
  catalogo as (
    insert into public.observed_tracks as o (
      deezer_track_id, deezer_artist_id, isrc, title, artist_name, album_name,
      cover_md5, genre, source_list,
      first_rank, first_popularity, last_rank, last_popularity, last_checked_at
    )
    select
      deezer_track_id, deezer_artist_id, isrc, title, artist_name, album_name,
      cover_md5, genre, source_list,
      rank, popularity, rank, popularity, now()
    from entrada
    on conflict (deezer_track_id) do update set
      last_rank       = excluded.last_rank,
      last_popularity = excluded.last_popularity,
      last_checked_at = now(),
      active          = true,
      -- metadado só melhora, nunca piora: se veio nulo agora, mantém o que tinha
      isrc            = coalesce(excluded.isrc, o.isrc),
      genre           = coalesce(excluded.genre, o.genre),
      cover_md5       = coalesce(excluded.cover_md5, o.cover_md5),
      album_name      = coalesce(excluded.album_name, o.album_name)
    returning 1
  ),
  historico as (
    insert into public.track_popularity_history (track_uri, popularity, rank, source)
    select 'deezer:track:' || deezer_track_id, popularity, rank, 'deezer'
    from entrada
    on conflict do nothing
    returning 1
  )
  -- CTEs que escrevem rodam mesmo sem serem referenciadas, mas as duas entram na
  -- conta para deixar isso explícito.
  select (select count(*) from historico) + 0 * (select count(*) from catalogo)
  into v_pontos;

  return v_pontos;
end $$;

revoke all on function public.record_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_observations(jsonb) to service_role;

-- Marca faixas que sumiram do Deezer (erro 800). Param de ser medidas, mas o
-- histórico já coletado fica.
create or replace function public.deactivate_observed_tracks(p_ids text[])
returns integer
language sql
as $$
  with atualizadas as (
    update public.observed_tracks
    set active = false, last_checked_at = now()
    where deezer_track_id = any(p_ids)
    returning 1
  )
  select count(*)::integer from atualizadas;
$$;

revoke all on function public.deactivate_observed_tracks(text[]) from public, anon, authenticated;
grant execute on function public.deactivate_observed_tracks(text[]) to service_role;
