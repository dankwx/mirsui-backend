-- 026_descoberta_por_album.sql
-- Segunda fonte de descoberta: caminhada por artista relacionado e álbum.
-- Ver docs/decisions/002-descoberta-por-album.md e a seção 4.6 da análise de
-- escala.
--
-- O PROBLEMA
-- A descoberta do ADR 001 usa `/artist/{id}/radio`, que é o motor de
-- recomendação da Deezer. Medido em 16/08/2026, com as mesmas cinco sementes
-- nos dois caminhos:
--
--   mecanismo          faixas/req   ISRC      rank mediana   rank p90
--   ------------------ ------------ --------- -------------- ----------
--   radio (ADR 001)    3,00         0/15      447.301        607.033
--   related -> album   4,65         93/93     38.978         144.526
--
-- Duas coisas erradas com o rádio, para a tese "achar antes de estourar":
--
--   1. Ele traz o que JÁ é popular. O p90 de 607.033 encosta no piso do chart
--      (721.380): um décimo do que a descoberta traz hoje é praticamente chart.
--   2. Ele NÃO traz ISRC — `radioDoArtista` grava `isrc: null` de propósito,
--      porque o endpoint não devolve o campo. Como o ISRC é o endereço da
--      página desde a 023, TODA faixa descoberta nasce sem página e cai na
--      fila da etapa 4, custando uma segunda requisição depois. O custo real
--      por faixa útil é ~2 requisições, não 1.
--
-- A REGRA NOVA
-- A partir de uma semente do catálogo: `/artist/{id}/related` devolve 20
-- artistas COM `nb_fan`, que é o dial de obscuridade; escolhe-se os menos
-- populares; `/artist/{id}/albums` devolve a discografia numa requisição; e
-- `/album/{id}/tracks` devolve 8-14 faixas com rank E ISRC por requisição.
--
-- O QUE A MEDIÇÃO IMPÔS AO DESENHO
-- `/related` de artista pequeno devolve ZERO artistas (verificado: artista
-- 58732 -> 0). O grafo seca na ponta obscura, então a caminhada NÃO pode
-- afundar sozinha em profundidade — ela precisa ser re-semeada do catálogo a
-- cada rodada. Por isso a fronteira abaixo guarda profundidade mas o job
-- trabalha a um salto: é uma limitação da fonte, não uma escolha.
--
-- POR QUE ISTO NÃO SUBSTITUI O RÁDIO
-- Ninguém sabe de que faixa de rank sai a faixa que estoura. Se o salto típico
-- for 400k -> 900k, o rádio está mirando certo e a caminhada erra o alvo; se
-- for 39k -> 400k, o contrário. Os dois convivem com o corte em
-- OBS_DESCOBERTA_SPLIT_ALBUM, e `source_list` distingue a procedência
-- ('album:N' contra 'radio:N') para que em 60 dias uma query responda qual
-- fonte produziu faixa que de fato se mexeu. É experimento, não aposta.

-- ---------------------------------------------------------------------------
-- 1. A fronteira da caminhada
-- ---------------------------------------------------------------------------
-- Sem esta tabela a rodada de amanhã rebusca as mesmas discografias: o
-- `recommendation_checked_at` da 20260815041317 marca SEMENTE consumida, e a
-- caminhada consome artista e álbum, que são outra unidade.
--
-- `next_album_index` guarda progresso parcial porque um artista pode ter mais
-- álbuns do que o orçamento de uma noite (medido: 36 no Daft Punk). A
-- paginação de `/artist/{id}/albums` por `index` foi verificada.

create table if not exists public.discovery_artists (
  deezer_artist_id text primary key,
  artist_name      text,
  -- O dial de obscuridade, vindo de graça no /related. Menos fãs = mais fundo.
  nb_fan           integer,
  -- Linhagem: de qual artista do catálogo este veio, e por qual faixa.
  parent_artist_id text,
  seed_track_id    text,
  depth            smallint    not null default 1,
  albums_total     smallint,
  next_album_index smallint    not null default 0,
  -- true = discografia inteira já colhida; sai da fila para sempre.
  exhausted        boolean     not null default false,
  first_seen_at    timestamptz not null default now(),
  last_harvest_at  timestamptz
);

comment on table public.discovery_artists is
  'Fronteira da descoberta por álbum: artistas alcançados via /artist/{id}/related e o quanto da discografia de cada um já foi colhido. Ver migration 026.';

comment on column public.discovery_artists.nb_fan is
  'Fãs no Deezer, lido do /related. É o critério de obscuridade: a fila é ordenada por este campo, crescente.';

comment on column public.discovery_artists.next_album_index is
  'Offset já consumido de /artist/{id}/albums. Progresso parcial: um artista com 36 álbuns não cabe numa noite.';

comment on column public.discovery_artists.exhausted is
  'Discografia inteira colhida. Sai da fila permanentemente — sem isto a fila devolveria o mesmo artista toda noite.';

-- A fila é "não exaurido, menos fãs primeiro". Índice parcial pelo mesmo
-- motivo do índice de sementes da 20260815041317: a fila é uma fatia pequena
-- de uma tabela que só cresce.
create index if not exists discovery_artists_fila_idx
  on public.discovery_artists (nb_fan asc nulls last, deezer_artist_id)
  where not exhausted;

-- ---------------------------------------------------------------------------
-- 2. A fila da caminhada
-- ---------------------------------------------------------------------------
-- Ordena por nb_fan crescente de propósito: o artista mais obscuro da fronteira
-- é colhido primeiro. Quando o orçamento aperta, quem fica para trás é o mais
-- popular — o inverso da prioridade da etapa 3, e pela mesma lógica (gastar o
-- que é escasso no que o mecanismo existe para trazer).

create or replace function public.discovery_artist_queue(p_limite integer)
returns table (
  deezer_artist_id text,
  artist_name      text,
  nb_fan           integer,
  seed_track_id    text,
  next_album_index smallint,
  albums_total     smallint
)
language sql
stable
as $$
  select
    a.deezer_artist_id,
    a.artist_name,
    a.nb_fan,
    a.seed_track_id,
    a.next_album_index,
    a.albums_total
  from public.discovery_artists a
  where not a.exhausted
  order by a.nb_fan asc nulls last, a.deezer_artist_id
  limit greatest(p_limite, 0);
$$;

comment on function public.discovery_artist_queue(integer) is
  'Fila da descoberta por álbum: artistas da fronteira ainda não exauridos, do mais obscuro para o menos. Ver migration 026.';

revoke all on function public.discovery_artist_queue(integer) from public, anon, authenticated;
grant execute on function public.discovery_artist_queue(integer) to service_role;

-- Quantos artistas a fronteira ainda tem. Existe pelo mesmo motivo de
-- observatory_queue_size() na 025: fronteira vazia é uma condição que precisa
-- gritar no log, não parar a descoberta em silêncio.
create or replace function public.discovery_frontier_size()
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.discovery_artists
  where not exhausted;
$$;

revoke all on function public.discovery_frontier_size() from public, anon, authenticated;
grant execute on function public.discovery_frontier_size() to service_role;

-- ---------------------------------------------------------------------------
-- 3. A gravação, numa transação só
-- ---------------------------------------------------------------------------
-- Faz o que record_recommendation_expansion faz (faixas + histórico + linhagem
-- + marca das sementes) e mais duas coisas que só a caminhada tem: inserir os
-- artistas novos na fronteira e avançar o progresso dos que foram colhidos.
--
-- Tudo junto de propósito. Se as faixas entrassem e o progresso não, a rodada
-- seguinte recolheria os mesmos álbuns; se o progresso entrasse e as faixas
-- não, os álbuns ficariam marcados como colhidos sem nunca terem entrado. As
-- duas falhas são silenciosas, que é a pior espécie.
--
-- SECURITY INVOKER pelo mesmo motivo da 20260815041317: quem chama é a
-- service_role do job, que já tem a permissão. A função não precisa elevar.

create or replace function public.record_album_expansion(
  p_rows           jsonb,
  p_parent_ids     text[],
  p_novos_artistas jsonb,
  p_progresso      jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_novas       integer := 0;
  v_pontos      integer := 0;
  v_ligadas     integer := 0;
  v_marcadas    integer := 0;
  v_fronteira   integer := 0;
  v_progredidos integer := 0;
begin
  if jsonb_typeof(coalesce(p_rows, '[]'::jsonb)) <> 'array' then
    raise exception 'p_rows precisa ser um array JSON';
  end if;

  -- Conta antes do upsert para o log distinguir faixa colhida de faixa NOVA:
  -- a caminhada devolve o álbum inteiro, e boa parte já está no catálogo.
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

  -- Sementes consumidas para expandir a fronteira. Mesma marca do ADR 001:
  -- uma faixa é semente uma vez só, não importa por qual caminho.
  update public.observed_tracks
  set recommendation_checked_at = coalesce(recommendation_checked_at, now())
  where deezer_track_id = any(coalesce(p_parent_ids, array[]::text[]));

  get diagnostics v_marcadas = row_count;

  -- Artistas novos na fronteira. `do nothing` no conflito: reencontrar um
  -- artista que já está na fronteira não pode zerar o progresso dele.
  if jsonb_array_length(coalesce(p_novos_artistas, '[]'::jsonb)) > 0 then
    with entrada as (
      select distinct on (deezer_artist_id) *
      from (
        select
          a->>'deezer_artist_id'   as deezer_artist_id,
          a->>'artist_name'        as artist_name,
          (a->>'nb_fan')::integer  as nb_fan,
          a->>'parent_artist_id'   as parent_artist_id,
          a->>'seed_track_id'      as seed_track_id,
          coalesce((a->>'depth')::smallint, 1::smallint) as depth
        from jsonb_array_elements(p_novos_artistas) as a
      ) bruto
      where deezer_artist_id is not null
      order by deezer_artist_id
    ),
    inseridos as (
      insert into public.discovery_artists
        (deezer_artist_id, artist_name, nb_fan, parent_artist_id, seed_track_id, depth)
      select deezer_artist_id, artist_name, nb_fan, parent_artist_id, seed_track_id, depth
      from entrada
      on conflict (deezer_artist_id) do nothing
      returning 1
    )
    select count(*)::integer from inseridos into v_fronteira;
  end if;

  -- Progresso da colheita. `greatest` no índice porque duas execuções
  -- concorrentes não podem fazer o offset ANDAR PARA TRÁS e recolher álbum
  -- que já entrou.
  if jsonb_array_length(coalesce(p_progresso, '[]'::jsonb)) > 0 then
    with entrada as (
      select distinct on (deezer_artist_id) *
      from (
        select
          p->>'deezer_artist_id'            as deezer_artist_id,
          (p->>'next_album_index')::smallint as next_album_index,
          (p->>'albums_total')::smallint     as albums_total,
          coalesce((p->>'exhausted')::boolean, false) as exhausted
        from jsonb_array_elements(p_progresso) as p
      ) bruto
      where deezer_artist_id is not null
      order by deezer_artist_id
    ),
    atualizados as (
      update public.discovery_artists a
      set next_album_index = greatest(a.next_album_index, e.next_album_index),
          albums_total     = coalesce(e.albums_total, a.albums_total),
          exhausted        = a.exhausted or e.exhausted,
          last_harvest_at  = now()
      from entrada e
      where a.deezer_artist_id = e.deezer_artist_id
      returning 1
    )
    select count(*)::integer from atualizados into v_progredidos;
  end if;

  return jsonb_build_object(
    'novas',       v_novas,
    'pontos',      v_pontos,
    'ligadas',     v_ligadas,
    'marcadas',    v_marcadas,
    'fronteira',   v_fronteira,
    'progredidos', v_progredidos
  );
end;
$$;

comment on function public.record_album_expansion(jsonb, text[], jsonb, jsonb) is
  'Grava a colheita da descoberta por álbum: faixas, histórico, linhagem, marca das sementes, artistas novos na fronteira e progresso da discografia — tudo numa transação. Ver migration 026.';

revoke all on function public.record_album_expansion(jsonb, text[], jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_album_expansion(jsonb, text[], jsonb, jsonb)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. A query do experimento
-- ---------------------------------------------------------------------------
-- A razão de as duas fontes conviverem: em ~60 dias esta query diz qual delas
-- produziu faixa que de fato se mexeu, e aí o corte
-- (OBS_DESCOBERTA_SPLIT_ALBUM) vira decisão medida em vez de chute.
--
-- Lê `origin_list` e não `source_list`: a 025 promove source_list para
-- 'acervo' quando alguém salva a faixa, e é justamente a faixa salva que mais
-- interessa contar aqui — ela não pode sumir da conta por ter dado certo.
--
-- 'moveu' é `prev_rank is not null`, o mesmo teste que a 025 usa para separar
-- "mudou" de "entrou": toda faixa tem um primeiro ponto, e contá-lo como
-- movimento faria as duas fontes empatarem em 100%.

create or replace function public.discovery_source_report()
returns table (
  fonte           text,
  faixas          integer,
  moveram         integer,
  subiram         integer,
  pct_moveu       numeric,
  rank_mediana    integer,
  salvas          integer
)
language sql
stable
as $$
  select
    case
      when o.origin_list like 'album:%' then 'album'
      when o.origin_list like 'radio:%' then 'radio'
      when o.origin_list like 'chart:%' then 'chart'
      else coalesce(o.origin_list, 'desconhecida')
    end                                                            as fonte,
    count(*)::integer                                              as faixas,
    count(*) filter (where o.prev_rank is not null)::integer        as moveram,
    count(*) filter (where o.prev_rank is not null
                       and o.last_rank > o.prev_rank)::integer      as subiram,
    round(100.0 * count(*) filter (where o.prev_rank is not null)
          / nullif(count(*), 0), 1)                                 as pct_moveu,
    (percentile_cont(0.5) within group (order by o.last_rank))::integer
                                                                    as rank_mediana,
    count(*) filter (where o.source_list = 'acervo')::integer       as salvas
  from public.observed_tracks o
  where o.active
  group by 1
  order by 2 desc;
$$;

comment on function public.discovery_source_report() is
  'Compara as fontes de descoberta pelo que importa: quantas faixas de cada uma realmente se mexeram e quantas foram salvas por alguém. É o que decide OBS_DESCOBERTA_SPLIT_ALBUM. Ver migration 026.';

revoke all on function public.discovery_source_report() from public, anon, authenticated;
grant execute on function public.discovery_source_report() to service_role;
