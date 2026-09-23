-- 040_ficha_do_artista.sql
-- A página de artista volta a ter tudo, sem perguntar ao Deezer na visita.
--
-- ------------------------------------------------------------
-- O PROBLEMA
-- ------------------------------------------------------------
-- A 038 tirou do Deezer a página dos artistas do catálogo, mas só com o que o
-- catálogo tinha: as faixas medidas. Medido na produção em 22/09/2026: Drake
-- com 4 faixas e 3 lançamentos, Taylor Swift com 11 e 8, Daft Punk com 10 e 7
-- (o Deezer lista 99 mais ouvidas e 36 lançamentos dele). Sem foto, sem fãs e
-- sem tipo de lançamento para nenhum. A 037 fez o contrário na faixa: a rodada
-- passou a guardar o que a página pedia, e a página ficou igual.
--
-- ------------------------------------------------------------
-- A FICHA
-- ------------------------------------------------------------
-- A rodada guarda, por artista, exatamente o que a página pedia na visita:
--
--   /artist/{id}              nome, foto (md5), fãs, nº de álbuns
--   /artist/{id}/top?limit=99 as mais ouvidas, com rank, duração e álbum
--   /artist/{id}/albums       a discografia, com tipo, capa e data (até 100)
--
-- Três requisições por artista, uma vez, e de novo quando a ficha passa de
-- OBS_FICHA_ARTISTA_DIAS (30). O catálogo de 22/09 tem 12.567 artistas: a
-- 2.000 por noite (OBS_LIMITE_FICHA_ARTISTA, ~6 mil requisições) a varredura
-- inicial leva uma semana. A fila começa por quem tem faixa salva e segue
-- pelo artista mais ouvido, que é a página que alguém de fato abre.
--
-- As listas moram em jsonb, uma linha por artista: a página lê uma linha, a
-- troca é atômica e não sobram linhas mortas de 99 faixas a cada renovação.
--
-- ------------------------------------------------------------
-- A PÁGINA
-- ------------------------------------------------------------
-- `get_artist_page` continua devolvendo as mesmas chaves (a 038 no ar segue
-- funcionando) e ganha foto, fãs, tipo de lançamento e `ficha`. As mais
-- ouvidas são as do Deezer; quando a faixa é medida pelo Observatório, o
-- ISRC, a data e a audiência saem da medição do dia, a mesma da curva.
-- Faixas medidas que o top do Deezer não traz (a obscura que alguém salvou)
-- entram também, ordenadas pelo rank. Sem ficha, a página mostra o recorte do
-- catálogo, como na 038.
--
-- Os convidados (feat.) entram no fim da fila: é para eles que os links
-- "com X" apontam, e sem ficha cada visita a eles custaria 3 chamadas.
--
-- Aplicar com `psql -v ON_ERROR_STOP=1 --single-transaction -f`. Pode ir antes
-- do backend novo: sem ele a tabela só fica vazia e a página segue a 038.

create table if not exists public.artist_details (
  deezer_artist_id text primary key,
  name             text,
  picture_md5      text,
  nb_fan           integer,
  nb_album         integer,
  -- [{deezer_track_id, title, deezer_artist_id, artist_name, deezer_album_id,
  --   album_name, cover_md5, duration_seconds, explicit_lyrics, rank,
  --   contributors}] na ordem do Deezer
  top              jsonb       not null default '[]'::jsonb,
  -- [{deezer_album_id, album_name, cover_md5, record_type, release_date,
  --   genre_id}] na ordem do Deezer
  albums           jsonb       not null default '[]'::jsonb,
  -- quantos lançamentos o Deezer diz ter; `albums` guarda até 100
  albums_total     integer,
  -- /artist/{id} respondeu "no data": o artista saiu do Deezer
  missing          boolean     not null default false,
  checked_at       timestamptz not null default now()
);

comment on table public.artist_details is
  'A ficha da página de artista: o que /artist/{id}, /top e /albums devolvem, guardado pela rodada para a visita não perguntar ao Deezer. Ver migration 040.';
comment on column public.artist_details.picture_md5 is
  'md5 da foto no CDN do Deezer; null = o artista não tem foto. Monte a URL com cdn-images.dzcdn.net/images/artist/{md5}/500x500-000000-80-0-0.jpg.';

-- A lição da 030: RLS desde o create table. Leitura pública, como a de
-- observed_tracks (são metadados públicos do Deezer); escrita só pela rodada,
-- com a service role.
alter table public.artist_details enable row level security;
revoke insert, update, delete, truncate on public.artist_details from anon, authenticated;
drop policy if exists "artist_details_select_public" on public.artist_details;
create policy "artist_details_select_public"
  on public.artist_details for select
  using (true);

create index if not exists artist_details_checked_at_idx
  on public.artist_details (checked_at);

-- ------------------------------------------------------------
-- A fila
-- ------------------------------------------------------------
-- Quem ainda não tem ficha vem antes de quem tem ficha velha. Dentro de cada
-- grupo: artista com faixa salva, depois artista principal antes de
-- convidado, depois o mais ouvido. A ordem é total (desempate pelo id) porque
-- a leitura é paginada pelo `.range()` do PostgREST — a lição da 031.
create or replace function public.artist_details_due(p_dias integer)
returns table (
  deezer_artist_id text,
  sem_ficha        boolean,
  salvo            boolean,
  convidado        boolean,
  melhor_rank      integer,
  checked_at       timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with candidatos as (
    select o.deezer_artist_id,
           o.source_list = 'acervo' as salvo,
           false as convidado,
           o.last_rank
    from public.observed_tracks o
    where o.active and o.deezer_artist_id is not null
    union all
    select c->>'id', false, true, null::integer
    from public.observed_tracks o
    cross join lateral jsonb_array_elements(o.contributors) c
    where o.active
      and jsonb_typeof(o.contributors) = 'array'
      and c->>'id' ~ '^[0-9]+$'
  ),
  artistas as (
    select c.deezer_artist_id,
           bool_or(c.salvo) as salvo,
           bool_and(c.convidado) as convidado,
           max(c.last_rank) as melhor_rank
    from candidatos c
    group by c.deezer_artist_id
  )
  select a.deezer_artist_id,
         d.deezer_artist_id is null,
         a.salvo,
         a.convidado,
         a.melhor_rank,
         d.checked_at
  from artistas a
  left join public.artist_details d on d.deezer_artist_id = a.deezer_artist_id
  where not exists (
          select 1 from public.blocked_artists b
          where b.deezer_artist_id = a.deezer_artist_id
        )
    and (d.deezer_artist_id is null
         or d.checked_at < now() - make_interval(days => greatest(coalesce(p_dias, 30), 1)));
$$;

create or replace function public.artist_details_queue_size(p_dias integer default 30)
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(*)::integer from public.artist_details_due(p_dias);
$$;

create or replace function public.artist_details_queue(p_limite integer, p_dias integer default 30)
returns table (deezer_artist_id text)
language sql
stable
security invoker
set search_path = ''
as $$
  select f.deezer_artist_id
  from public.artist_details_due(p_dias) f
  order by f.sem_ficha desc,
           f.salvo desc,
           f.convidado asc,
           f.melhor_rank desc nulls last,
           f.checked_at asc nulls first,
           f.deezer_artist_id
  limit greatest(coalesce(p_limite, 0), 0);
$$;

-- ------------------------------------------------------------
-- A gravação
-- ------------------------------------------------------------
-- Uma linha por artista, trocada inteira. O TypeScript já manda só valor
-- válido; os `case` aqui são a segunda trava, porque um cast que falha
-- derruba o lote inteiro. Artista que saiu do Deezer (`missing`) mantém a
-- ficha antiga para consulta, mas a página deixa de usá-la.
create or replace function public.record_artist_details(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_artistas integer;
begin
  with entrada as (
    select distinct on (deezer_artist_id) *
    from (
      select
        r->>'deezer_artist_id' as deezer_artist_id,
        nullif(btrim(r->>'name'), '') as name,
        case when r->>'picture_md5' ~ '^[0-9a-f]{32}$' then r->>'picture_md5' end as picture_md5,
        case when r->>'nb_fan' ~ '^[0-9]{1,9}$' then (r->>'nb_fan')::integer end as nb_fan,
        case when r->>'nb_album' ~ '^[0-9]{1,9}$' then (r->>'nb_album')::integer end as nb_album,
        case when r->>'albums_total' ~ '^[0-9]{1,9}$' then (r->>'albums_total')::integer end as albums_total,
        case when jsonb_typeof(r->'top') = 'array' then r->'top' else '[]'::jsonb end as top,
        case when jsonb_typeof(r->'albums') = 'array' then r->'albums' else '[]'::jsonb end as albums,
        case when jsonb_typeof(r->'missing') = 'boolean'
             then (r->>'missing')::boolean else false end as missing
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    ) bruto
    where deezer_artist_id ~ '^[0-9]+$'
    order by deezer_artist_id
  )
  insert into public.artist_details as d (
    deezer_artist_id, name, picture_md5, nb_fan, nb_album, top, albums,
    albums_total, missing, checked_at
  )
  select e.deezer_artist_id, e.name, e.picture_md5, e.nb_fan, e.nb_album, e.top, e.albums,
         e.albums_total, e.missing, now()
  from entrada e
  on conflict (deezer_artist_id) do update set
    name         = case when excluded.missing then d.name else coalesce(excluded.name, d.name) end,
    picture_md5  = case when excluded.missing then d.picture_md5 else excluded.picture_md5 end,
    nb_fan       = case when excluded.missing then d.nb_fan else excluded.nb_fan end,
    nb_album     = case when excluded.missing then d.nb_album else excluded.nb_album end,
    top          = case when excluded.missing then d.top else excluded.top end,
    albums       = case when excluded.missing then d.albums else excluded.albums end,
    albums_total = case when excluded.missing then d.albums_total else excluded.albums_total end,
    missing      = excluded.missing,
    checked_at   = now();

  get diagnostics v_artistas = row_count;
  return v_artistas;
end $$;

revoke all on function public.artist_details_due(integer) from public, anon, authenticated;
revoke all on function public.artist_details_queue_size(integer) from public, anon, authenticated;
revoke all on function public.artist_details_queue(integer, integer) from public, anon, authenticated;
revoke all on function public.record_artist_details(jsonb) from public, anon, authenticated;
grant execute on function public.artist_details_due(integer) to service_role;
grant execute on function public.artist_details_queue_size(integer) to service_role;
grant execute on function public.artist_details_queue(integer, integer) to service_role;
grant execute on function public.record_artist_details(jsonb) to service_role;

-- ------------------------------------------------------------
-- A leitura da página
-- ------------------------------------------------------------
-- Mesmas chaves da 038 em `top` e `albums`, mais as da ficha. A audiência de
-- faixa não medida sai do rank da ficha pela mesma conta de popScore()
-- (src/lib/stakePoints.ts): rank / 10.000, de 0 a 100.
create or replace function public.get_artist_page(p_deezer_artist_id text)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with ficha as (
    select d.*
    from public.artist_details d
    where d.deezer_artist_id = p_deezer_artist_id
      and not d.missing
  ),
  catalogo as (
    select o.*
    from public.observed_tracks o
    where o.deezer_artist_id = p_deezer_artist_id and o.active
    order by o.last_rank desc nulls last, o.deezer_track_id
    limit 99
  ),
  nome as (
    select coalesce(
      (select f.name from ficha f),
      (select c.artist_name from catalogo c
        order by c.last_rank desc nulls last, c.deezer_track_id limit 1)
    ) as name
  ),
  -- As mais ouvidas do Deezer, com a medição do Observatório por cima quando
  -- a faixa é medida.
  do_deezer as (
    select
      t.item->>'deezer_track_id' as deezer_track_id,
      o.isrc,
      coalesce(t.item->>'title', o.title) as title,
      coalesce(t.item->>'artist_name', o.artist_name) as artist_name,
      coalesce(t.item->>'deezer_artist_id', o.deezer_artist_id) as deezer_artist_id,
      coalesce(t.item->>'deezer_album_id', o.deezer_album_id) as deezer_album_id,
      coalesce(t.item->>'album_name', o.album_name) as album_name,
      coalesce(t.item->>'cover_md5', o.cover_md5) as cover_md5,
      o.release_date,
      coalesce(
        case when t.item->>'duration_seconds' ~ '^[0-9]{1,6}$'
             then (t.item->>'duration_seconds')::integer end,
        o.duration_seconds
      ) as duration_seconds,
      coalesce(
        case when jsonb_typeof(t.item->'contributors') = 'array'
              and jsonb_array_length(t.item->'contributors') > 0
             then t.item->'contributors' end,
        o.contributors
      ) as contributors,
      o.active is true as medida,
      case when o.active then o.last_rank
           when t.item->>'rank' ~ '^[0-9]{1,9}$' then (t.item->>'rank')::integer
      end as rank,
      case when o.active then o.last_popularity end as popularidade_medida,
      t.ordem
    from ficha f
    cross join lateral jsonb_array_elements(f.top) with ordinality as t(item, ordem)
    left join public.observed_tracks o on o.deezer_track_id = t.item->>'deezer_track_id'
    where t.item->>'deezer_track_id' is not null
  ),
  -- Medidas que o top do Deezer não traz. Entram todas (até 99), além das 99
  -- do Deezer: é aqui que mora a faixa obscura que alguém salvou, e cortar
  -- a lista pelo rank a tiraria também do "quem já garimpou".
  so_do_catalogo as (
    select
      c.deezer_track_id, c.isrc, c.title, c.artist_name, c.deezer_artist_id,
      c.deezer_album_id, c.album_name, c.cover_md5, c.release_date,
      c.duration_seconds, c.contributors,
      true as medida, c.last_rank as rank, c.last_popularity as popularidade_medida,
      null::bigint as ordem
    from catalogo c
    where not exists (select 1 from do_deezer d where d.deezer_track_id = c.deezer_track_id)
  ),
  top as (
    select * from do_deezer
    union all
    select * from so_do_catalogo
  ),
  album_do_catalogo as (
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
    -- Da ficha, quando há: a discografia do Deezer, com tipo. A data fica em
    -- texto: o TypeScript só grava data válida, e `data_do_deezer` não é
    -- executável por anon (037). 'AAAA-MM-DD' ordena igual a uma data.
    select
      a.item->>'deezer_album_id' as deezer_album_id,
      a.item->>'album_name' as album_name,
      a.item->>'cover_md5' as cover_md5,
      case when a.item->>'release_date' ~ '^[12][0-9]{3}-[01][0-9]-[0-3][0-9]$'
           then a.item->>'release_date' end as release_date,
      a.item->>'record_type' as record_type,
      a.ordem
    from ficha f
    cross join lateral jsonb_array_elements(f.albums) with ordinality as a(item, ordem)
    where a.item->>'deezer_album_id' is not null and a.item->>'album_name' is not null
    union all
    -- Sem ficha: o recorte do catálogo, como na 038.
    select l.deezer_album_id, l.album_name, l.cover_md5, l.release_date::text, null, null
    from album_do_catalogo l
    where not exists (select 1 from ficha)
  ),
  albuns_limitados as (
    select * from albuns
    order by release_date desc nulls last, ordem nulls last, album_name, deezer_album_id
    limit 100
  )
  select jsonb_build_object(
    'name', n.name,
    'ficha', exists (select 1 from ficha),
    'ficha_em', (select f.checked_at from ficha f),
    'picture_md5', (select f.picture_md5 from ficha f),
    'nb_fan', (select f.nb_fan from ficha f),
    'nb_album', (select f.nb_album from ficha f),
    'albums_total', (select f.albums_total from ficha f),
    'top', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deezer_track_id', t.deezer_track_id, 'isrc', t.isrc,
        'title', t.title, 'artist_name', t.artist_name,
        'deezer_artist_id', t.deezer_artist_id,
        'deezer_album_id', t.deezer_album_id, 'album_name', t.album_name,
        'cover_md5', t.cover_md5, 'release_date', t.release_date,
        'duration_seconds', t.duration_seconds,
        'last_popularity', coalesce(
          t.popularidade_medida,
          least(100, greatest(0, round(coalesce(t.rank, 0) / 10000.0)))::integer
        ),
        'medida', t.medida,
        'contributors', t.contributors
      ) order by t.rank desc nulls last, t.ordem nulls last, t.deezer_track_id)
      from top t
    ), '[]'::jsonb),
    'albums', coalesce((
      select jsonb_agg(jsonb_build_object(
        'deezer_album_id', l.deezer_album_id, 'album_name', l.album_name,
        'cover_md5', l.cover_md5, 'release_date', l.release_date,
        'record_type', l.record_type
      ) order by l.release_date desc nulls last, l.ordem nulls last, l.album_name, l.deezer_album_id)
      from albuns_limitados l
    ), '[]'::jsonb)
  )
  from nome n
  where n.name is not null;
$$;

revoke all on function public.get_artist_page(text) from public;
grant execute on function public.get_artist_page(text) to anon, authenticated, service_role;
