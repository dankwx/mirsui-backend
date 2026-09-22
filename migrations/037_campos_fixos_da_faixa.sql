-- 037_campos_fixos_da_faixa.sql
-- A página de faixa deixa de perguntar ao Deezer a cada visita.
--
-- ------------------------------------------------------------
-- O PROBLEMA
-- ------------------------------------------------------------
-- O site e a medição dividem a mesma cota do `mirsui-deezer-gateway`
-- (~3 req/s por IP). A página de faixa pedia `/track/isrc:X` (cache de 15 min)
-- e `/artist/{id}` a cada visita fora do cache. Um robô que percorre 100 mil
-- páginas diferentes, uma vez cada, passa todas fora do cache: com ~1 página
-- nova por segundo a cota enche e a medição fica com 1/7 dela (rodízio 4:2:1).
-- Ver docs/propostas-22-09-2026.md, proposta 1.
--
-- Quase tudo que a página lia do Deezer já estava aqui (título, artista,
-- álbum, capa, gênero, ISRC, rank). Faltavam os campos que não mudam. Eles
-- vêm de graça nas respostas que a rodada JÁ pede, e eram descartados:
--
--   campo              chart  /album/{id}/tracks  /track/{id}  busca/rádio
--   duration_seconds     x            x                x            x
--   explicit_lyrics      x            x                x            x
--   has_preview          x            x                x            x
--   release_date                                       x
--   contributors                                      x
--
-- Conferido numa resposta real em 22/09/2026. Custo: zero requisições a mais.
--
-- O que NÃO vinha de graça, e a proposta original dava como já resolvido:
--
--   gênero  mora no álbum, e só o chart o traz. 74% das faixas ativas não
--           têm (dump de 03/09) — as de descoberta e rádio. A página pedia
--           `/album/{id}` a cada visita para cobrir isso.
--   data    só vem de `/track/{id}`, que mede ~27% do catálogo. O resto é
--           medido por `/album/{id}/tracks`, que não a traz.
--
-- Duas saídas, as duas na rodada da noite:
--
--   1. A descoberta por álbum já tem a discografia na mão, e
--      `/artist/{id}/albums` traz `genre_id` e `release_date` de cada álbum.
--      O que ela colhe passa a nascer com gênero e data, de graça.
--   2. Etapa 4b: uma requisição a `/album/{id}` por álbum que ainda falta
--      gênero ou data, para todas as faixas dele. Com teto por noite
--      (OBS_LIMITE_FICHA_ALBUM). É uma varredura única do catálogo que já
--      existe; depois, a fila é só o que chega por rádio e chart.
--
-- Participações (feat.) seguem só de `/track/{id}`: o álbum não as traz por
-- faixa. Sem elas a página mostra o artista principal, como o catálogo sempre
-- teve — e o Deezer costuma pôr o "(feat. X)" no próprio título.
--
-- A PRÉVIA NÃO É GUARDADA. A URL do MP3 vem assinada com prazo (`hdnea=exp=`)
-- e vence em poucas horas. O que se guarda é SE ela existe (`has_preview`),
-- para a página saber se mostra o player; a URL é pedida quando alguém aperta
-- play (app/api/previa/[id] no mirsui-web).
--
-- Aplicar com `psql -v ON_ERROR_STOP=1 --single-transaction -f`. Pode ir antes
-- ou depois do backend novo: o `record_observations` antigo ignora as chaves
-- que não conhece, e o novo trata a ausência delas como "não disse".

alter table public.observed_tracks
  add column if not exists duration_seconds integer,
  add column if not exists explicit_lyrics  boolean,
  add column if not exists has_preview      boolean,
  add column if not exists release_date     date,
  add column if not exists contributors     jsonb;

comment on column public.observed_tracks.has_preview is
  'Se o Deezer tem prévia de 30 s desta gravação na última resposta que disse. A URL NÃO é guardada: é assinada e vence em horas. Ver migration 037.';
comment on column public.observed_tracks.contributors is
  'Artistas creditados, em ordem ([{id, name}], principal primeiro). Só /track/{id} traz; null = ainda não visto por ele. Ver migration 037.';
comment on column public.observed_tracks.release_date is
  'Data de lançamento: a da faixa quando veio de /track/{id}, a do álbum quando veio pela descoberta por álbum. Ver migration 037.';

-- O Deezer manda `0000-00-00` para data desconhecida, e um cast inválido
-- abortaria o lote inteiro de `record_observations`. Esta função nunca lança.
--
-- SQL puro, sem bloco `exception`: em plpgsql cada chamada com `exception`
-- abre uma subtransação, e isto roda uma vez por linha de um lote de centenas
-- — passar de 64 subtransações numa transação é o que faz o Postgres
-- degradar. O `case` aninhado garante a ordem: o dia só é conferido depois de
-- o formato ter passado, e o cast só acontece com a data já validada.
create or replace function public.data_do_deezer(p text)
returns date
language sql
immutable
set search_path = ''
as $$
  select case
    when p ~ '^[12][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
      case
        when substr(p, 9, 2)::integer <= extract(day from (
               make_date(substr(p, 1, 4)::integer, substr(p, 6, 2)::integer, 1)
               + interval '1 month' - interval '1 day'
             ))::integer
        then p::date
      end
  end
$$;

revoke all on function public.data_do_deezer(text) from public, anon, authenticated;
grant execute on function public.data_do_deezer(text) to service_role;

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
        (r->>'popularity')::integer as popularity,
        -- Campos fixos (037). O TypeScript já manda só valor válido ou null;
        -- a checagem aqui é a segunda trava, porque um cast que falha derruba
        -- o lote inteiro e o dia de medição daquele lote não volta.
        case when r->>'duration_seconds' ~ '^[0-9]{1,6}$'
             then nullif((r->>'duration_seconds')::integer, 0) end as duration_seconds,
        case when jsonb_typeof(r->'explicit_lyrics') = 'boolean'
             then (r->>'explicit_lyrics')::boolean end as explicit_lyrics,
        case when jsonb_typeof(r->'has_preview') = 'boolean'
             then (r->>'has_preview')::boolean end as has_preview,
        public.data_do_deezer(r->>'release_date') as release_date,
        case when jsonb_typeof(r->'contributors') = 'array'
              and jsonb_array_length(r->'contributors') > 0
             then r->'contributors' end as contributors
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
      duration_seconds, explicit_lyrics, has_preview, release_date, contributors,
      last_change_at, prev_rank
    )
    select
      m.deezer_track_id, m.deezer_artist_id, m.deezer_album_id, m.isrc, m.title, m.artist_name,
      m.album_name, m.cover_md5, m.genre, m.source_list, m.source_list,
      m.rank, m.popularity, m.rank, m.popularity, now(),
      m.duration_seconds, m.explicit_lyrics, m.has_preview, m.release_date, m.contributors,
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
      -- Mesma regra para os campos fixos: o endpoint que não traz o campo
      -- (álbum não traz data nem participações) não apaga o que /track trouxe.
      -- `has_preview` é o único que muda de verdade; vale a última resposta
      -- que disse alguma coisa.
      duration_seconds = coalesce(excluded.duration_seconds, o.duration_seconds),
      explicit_lyrics  = coalesce(excluded.explicit_lyrics, o.explicit_lyrics),
      has_preview      = coalesce(excluded.has_preview, o.has_preview),
      release_date     = coalesce(excluded.release_date, o.release_date),
      contributors     = coalesce(excluded.contributors, o.contributors),
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
  'Grava catálogo + histórico. O histórico só recebe linha quando o rank difere do último ponto gravado (021), com a largura da janela de medição em measured_gap_days (025). Guarda os campos fixos da gravação que vêm na resposta (037). Retorna o número de MUDANÇAS gravadas, não de medições.';

revoke all on function public.record_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_observations(jsonb) to service_role;

-- ------------------------------------------------------------
-- A FICHA DOS ÁLBUNS: gênero e data que faltam (etapa 4b)
-- ------------------------------------------------------------
-- O gênero mora no álbum, e só o chart o entrega de graça. Medido no dump de
-- 03/09/2026: 13.062 de 17.653 faixas ativas (74%) sem gênero, quase todas
-- vindas de descoberta por álbum ou rádio — e é por isso que a página pedia
-- `/album/{id}` na visita. A descoberta por álbum passa a gravar gênero e data
-- que já recebe; para o resto, uma requisição a `/album/{id}` por álbum
-- preenche todas as faixas dele. A marca é "já perguntei", pela mesma razão
-- da `isrc_checked_at` (migration 010): álbum sem gênero no Deezer sai da fila
-- em vez de voltar toda noite.

alter table public.observed_tracks
  add column if not exists album_checked_at timestamptz;

comment on column public.observed_tracks.album_checked_at is
  'Quando a etapa 4b perguntou /album/{id} por gênero e data desta faixa. Null = nunca. Ver migration 037.';

create index if not exists observed_tracks_ficha_album_pendente_idx
  on public.observed_tracks (deezer_album_id)
  where active
    and album_checked_at is null
    and deezer_album_id is not null
    and (genre is null or release_date is null);

create or replace function public.album_details_queue_size()
returns integer
language sql
stable
security invoker
set search_path = ''
as $$
  select count(distinct o.deezer_album_id)::integer
  from public.observed_tracks o
  where o.active
    and o.album_checked_at is null
    and o.deezer_album_id is not null
    and (o.genre is null or o.release_date is null);
$$;

-- Álbuns de faixas salvas primeiro (é a página que alguém de fato abre),
-- depois os que dão página a mais faixas por requisição. A ordem é total
-- (desempate pelo id) porque a leitura é paginada pelo `.range()` do
-- PostgREST — a lição da migration 031.
create or replace function public.album_details_queue(p_limite integer)
returns table (deezer_album_id text, faixas integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select o.deezer_album_id, count(*)::integer as faixas
  from public.observed_tracks o
  where o.active
    and o.album_checked_at is null
    and o.deezer_album_id is not null
    and (o.genre is null or o.release_date is null)
  group by o.deezer_album_id
  order by bool_or(o.source_list = 'acervo') desc, count(*) desc, o.deezer_album_id
  limit greatest(coalesce(p_limite, 0), 0);
$$;

-- Grava o que o álbum disse e marca as faixas dele como consultadas. Gênero
-- e data só preenchem vazio: o gênero do chart e a data da própria faixa
-- (/track/{id}) são mais precisos que os do álbum e nunca são sobrescritos.
create or replace function public.record_album_details(p_rows jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_faixas integer;
begin
  with entrada as (
    select distinct on (deezer_album_id) *
    from (
      select
        r->>'deezer_album_id'                    as deezer_album_id,
        nullif(btrim(r->>'genre'), '')           as genre,
        public.data_do_deezer(r->>'release_date') as release_date
      from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) as r
    ) bruto
    where deezer_album_id is not null
    order by deezer_album_id
  )
  update public.observed_tracks o
  set genre            = coalesce(o.genre, e.genre),
      release_date     = coalesce(o.release_date, e.release_date),
      album_checked_at = now()
  from entrada e
  where o.deezer_album_id = e.deezer_album_id
    and o.album_checked_at is null;

  get diagnostics v_faixas = row_count;
  return v_faixas;
end $$;

revoke all on function public.album_details_queue_size() from public, anon, authenticated;
revoke all on function public.album_details_queue(integer) from public, anon, authenticated;
revoke all on function public.record_album_details(jsonb) from public, anon, authenticated;
grant execute on function public.album_details_queue_size() to service_role;
grant execute on function public.album_details_queue(integer) to service_role;
grant execute on function public.record_album_details(jsonb) to service_role;

-- A página lê os campos novos na mesma requisição de sempre. Igual à 029, com
-- cinco chaves a mais em `observada`.
create or replace function public.get_track_page(p_isrc text)
returns jsonb
language sql
stable
as $$
  with canonica as (
    select o.*
    from public.observed_tracks o
    where o.isrc = p_isrc
      and o.active
    order by o.last_rank desc nulls last, o.deezer_track_id
    limit 1
  ),
  -- A chave opaca do acervo. `tracks.track_uri` guarda `spotify:track:<id>`
  -- para tudo que foi salvo antes da migration 023, e `isrc:<ISRC>` para o que
  -- veio depois. As duas formas apontam para a mesma gravação e precisam contar
  -- junto — é a regra que o utils/trackClaims.ts monta no `.or()` do PostgREST,
  -- e que aqui vira uma expressão só.
  chave as (
    select coalesce(
             (select 'spotify:track:' || c.spotify_track_id
                from canonica c
               where c.spotify_track_id is not null),
             'isrc:' || p_isrc
           ) as uri
  ),
  salvas as (
    select t.user_id, t.position, t.claimedat
    from public.tracks t
    where t.isrc = p_isrc
       or t.track_uri = (select uri from chave)
  ),
  -- Os oito primeiros a chegar. `nulls last` porque linha antiga sem posição
  -- não pode passar na frente de quem tem o número.
  primeiros as (
    select s.user_id, s.position, s.claimedat
    from salvas s
    order by s.position asc nulls last
    limit 8
  )
  select jsonb_build_object(
    -- As mesmas colunas da interface `FaixaObservada`, em utils/trackIdentity.ts.
    -- Explícitas em vez
    -- de `to_jsonb(c)`: a tabela tem 20+ colunas de controle do Observatório
    -- (cadence_*, *_checked_at, recommendation_*) que a página não lê e que não
    -- têm por que viajar.
    'observada', (
      select jsonb_build_object(
        'deezer_track_id',  c.deezer_track_id,
        'deezer_artist_id', c.deezer_artist_id,
        'isrc',             c.isrc,
        'title',            c.title,
        'artist_name',      c.artist_name,
        'album_name',       c.album_name,
        'cover_md5',        c.cover_md5,
        'genre',            c.genre,
        'spotify_track_id', c.spotify_track_id,
        'last_rank',        c.last_rank,
        'last_popularity',  c.last_popularity,
        'duration_seconds', c.duration_seconds,
        'explicit_lyrics',  c.explicit_lyrics,
        'has_preview',      c.has_preview,
        'release_date',     c.release_date,
        'contributors',     c.contributors
      )
      from canonica c
    ),
    'curva', public.get_track_curve(p_isrc),
    'salvamentos', (select count(*) from salvas),
    'quem_salvou', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'user_id',   p.user_id,
                   'position',  p.position,
                   'claimedat', p.claimedat,
                   -- `left join` e não `inner`: o embed do PostgREST em
                   -- trackClaims.ts é `profiles:user_id ( ... )` sem `!inner`,
                   -- então salvamento cujo perfil sumiu continua contando na
                   -- lista em vez de desaparecer dela.
                   'profiles',  case
                                  when pr.id is null then null
                                  else jsonb_build_object(
                                    'username',     pr.username,
                                    'avatar_url',   pr.avatar_url,
                                    'display_name', pr.display_name
                                  )
                                end
                 )
                 order by p.position asc nulls last
               )
        from primeiros p
        left join public.profiles pr on pr.id = p.user_id
      ),
      '[]'::jsonb
    )
  );
$$;

comment on function public.get_track_page(text) is
  'A página da faixa numa requisição: linha do Observatório, curva, contagem de '
  'salvamentos e os 8 primeiros a salvar. Substitui 4 chamadas REST — ver o '
  'cabeçalho da migration 029 para o porquê (o custo era cabeçalho HTTP, não '
  'dado). Não inclui o salvamento do próprio usuário: esse depende de sessão.';

grant execute on function public.get_track_page(text) to anon, authenticated;
