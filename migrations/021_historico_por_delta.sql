-- 021_historico_por_delta.sql
-- Item 3 da análise de escala: o histórico passa a guardar MUDANÇA, não medição.
-- Ver docs/analise-escala-apis-e-banco.md, seções 3 e 5.2.
--
-- Esta migration muda só comportamento (três funções). A compactação das linhas
-- redundantes que já estão gravadas está separada, em 022 — apagar dado é uma
-- decisão à parte de mudar a regra de escrita, e a regra nova já funciona sem
-- ela.
--
-- O PORQUÊ
-- 91,9% das medições consecutivas registram um rank idêntico ao do dia anterior.
-- São linhas que existem para dizer que nada mudou, e é isso que faz o Postgres
-- estourar antes da cota do Deezer — o gargalo real (seção 2.2).
--
-- A REGRA
-- Grava-se um ponto quando o rank difere do último ponto JÁ GRAVADO daquela
-- faixa. "Não mudou" passa a ser implícito: se não há ponto no dia, o valor é o
-- do último ponto anterior. A primeira medição de uma faixa sempre entra
-- (`is distinct from` com NULL do lado esquerdo é verdadeiro).
--
-- Comparar contra o histórico e não contra observed_tracks.last_rank é de
-- propósito: last_rank é atualizado em toda rodada, inclusive quando o ponto é
-- descartado. Quem manda é o que está na tabela — assim a regra se auto-corrige
-- se uma escrita falhar no meio, e o `on conflict do nothing` do índice do dia
-- continua valendo sem criar deriva entre as duas colunas.
--
-- POR QUE ISSO NÃO É BACKFILL
-- A migration 009 estabelece que curva de subida não tem backfill: ou você mediu
-- naquele dia, ou o ponto não existe. Isso continua valendo. A diferença é que
-- aqui a medição ACONTECEU — o job passou por aquela faixa naquele dia e leu o
-- mesmo valor. Preencher a lacuna com o valor anterior não inventa medição, só
-- desempacota a que foi feita. É codificação, não invenção.
--
-- ATENÇÃO PARA O ITEM 4 (cadência adaptativa)
-- Essa equivalência depende de o job medir todas as faixas todo dia, que é o
-- regime de hoje. Quando a cadência adaptativa entrar, faixa fria passará 30
-- dias sem medição, e aí forward-fill sobre o intervalo não medido SERIA
-- invenção. O item 4 precisa resolver isso — a grade abaixo vai até
-- `last_checked_at`, então a função já não extrapola além da última medição
-- real; o que faltará é distinguir "medi e não mudou" de "não medi".
--
-- VERIFICAÇÃO (rodada em produção antes de aplicar, 15/08/2026)
-- Reconstruindo a série densa a partir do delta, em todas as faixas:
--
--   linhas_hoje      20.990
--   linhas_com_delta  7.670   (−63,5%)
--   divergências          0   ← forward-fill é lossless
--
-- Os 63,5% ficam abaixo dos 91,9% da seção 3 porque o histórico tem só 6 dias e
-- a primeira linha de cada faixa sempre entra: são 6.490 faixas com ~3,2 pontos
-- cada. A economia tende a 92% conforme a série alonga.

-- ---------------------------------------------------------------------------
-- 1. Escrita: só o que mudou
-- ---------------------------------------------------------------------------

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
  -- Último rank efetivamente gravado de cada faixa do lote. Todas as CTEs deste
  -- comando enxergam o mesmo snapshot, então isto é o estado ANTES da rodada,
  -- mesmo com a CTE `catalogo` acima escrevendo.
  ultimo as (
    select e.deezer_track_id, u.rank as rank_gravado
    from entrada e
    left join lateral (
      select h.rank
      from public.track_popularity_history h
      where h.track_uri = 'deezer:track:' || e.deezer_track_id
        and h.rank is not null
      order by h.recorded_at desc
      limit 1
    ) u on true
  ),
  historico as (
    insert into public.track_popularity_history (track_uri, popularity, rank, source)
    select 'deezer:track:' || e.deezer_track_id, e.popularity, e.rank, 'deezer'
    from entrada e
    join ultimo u on u.deezer_track_id = e.deezer_track_id
    -- `is distinct from` e não `<>`: faixa nova tem rank_gravado nulo e precisa
    -- entrar. Com `<>` o NULL faria a linha sumir e nenhuma faixa nova teria
    -- primeiro ponto.
    where u.rank_gravado is distinct from e.rank
    on conflict do nothing
    returning 1
  )
  -- CTEs que escrevem rodam mesmo sem serem referenciadas, mas as duas entram na
  -- conta para deixar isso explícito.
  select (select count(*) from historico) + 0 * (select count(*) from catalogo)
  into v_pontos;

  return v_pontos;
end $$;

-- O retorno mudou de significado: era "medições gravadas" (≈ o tamanho do lote)
-- e agora é "mudanças gravadas". O job soma isso em `resultado.pontos`, então o
-- log da rodada vai mostrar um número muito menor a partir daqui — isso é o
-- efeito pretendido, não uma rodada que falhou.
comment on function public.record_observations(jsonb) is
  'Grava catálogo + histórico. O histórico só recebe linha quando o rank difere do último ponto gravado (migration 021). Retorna o número de MUDANÇAS gravadas, não de medições.';

revoke all on function public.record_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_observations(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Leitura da curva: desempacota o delta
-- ---------------------------------------------------------------------------
-- A saída é igual à de antes (um {d, r} por dia): a página não muda. Verificado
-- contra a série densa antes de aplicar.
--
-- A grade vai do primeiro ponto até `last_checked_at`, não até hoje: se o job
-- parou de medir a faixa há uma semana, a curva termina na última medição real
-- em vez de esticar uma linha reta que ninguém observou.

create or replace function public.get_track_curve(p_isrc text)
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
  )
  select jsonb_build_object(
    'deezer_track_id', c.deezer_track_id,
    'genre',           c.genre,
    'observed_since',  c.added_at,
    'first_rank',      c.first_rank,
    'last_rank',       c.last_rank,
    'series', coalesce(
      (
        with pontos as (
          select (h.recorded_at at time zone 'UTC')::date as d, h.rank as r
          from public.track_popularity_history h
          where h.track_uri = 'deezer:track:' || c.deezer_track_id
            and h.rank is not null
        ),
        -- Um dia por linha, do primeiro ponto até a última medição real.
        -- generate_series com limite nulo devolve zero linhas, que é o que
        -- queremos para faixa sem histórico nenhum.
        grade as (
          select g::date as d
          from generate_series(
                 (select min(d) from pontos),
                 greatest(
                   (select max(d) from pontos),
                   (c.last_checked_at at time zone 'UTC')::date
                 ),
                 interval '1 day'
               ) g
        ),
        -- Forward-fill idiomático em Postgres: `ignore nulls` não existe aqui,
        -- então conta-se quantos not-null vieram até cada linha e usa-se esse
        -- contador como grupo — dentro do grupo, o primeiro valor é o vigente.
        juncao as (
          select gr.d, p.r, count(p.r) over (order by gr.d) as grupo
          from grade gr
          left join pontos p on p.d = gr.d
        ),
        preenchida as (
          select d, first_value(r) over (partition by grupo order by d) as r
          from juncao
        )
        select jsonb_agg(jsonb_build_object('d', d, 'r', r) order by d)
        from preenchida
      ),
      '[]'::jsonb
    )
  )
  from canonica c;
$$;

grant execute on function public.get_track_curve(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Landing: a janela de observação não é mais o número de linhas
-- ---------------------------------------------------------------------------
-- A versão da 015 derivava três coisas do histórico:
--
--   pontos       = count(*)                                    -> continua válido
--   dias         = max(recorded_at)::date - min(...)::date     -> QUEBRA
--   rank_inicial = (array_agg(rank order by recorded_at))[1]   -> desnecessário
--
-- `dias` media a distância entre a primeira e a última LINHA. Com gravação por
-- delta isso vira a distância entre a primeira e a última MUDANÇA: uma faixa que
-- subiu no dia 2 e ficou parada até o dia 40 passaria a ter dias = 1 e cairia no
-- corte de 3 dias — justamente a faixa que mais interessa mostrar. A janela de
-- observação agora sai de observed_tracks (added_at → last_checked_at), que é o
-- que "dias" sempre quis dizer.
--
-- `rank_inicial` já existe em observed_tracks.first_rank, gravado na entrada da
-- faixa e nunca alterado. Ler dali é mais barato e imune ao delta.
--
-- `pontos >= 2` sobrevive com o sentido intacto: a primeira medição sempre gera
-- linha, então pontos >= 2 continua significando "mudou pelo menos uma vez".

create or replace function public.get_landing_observatory(p_limite integer default 8)
returns jsonb
language sql
stable
as $$
  with base as (
    -- Uma linha por gravação (o Deezer repete a mesma faixa em ids diferentes).
    select distinct on (o.isrc) o.*
    from public.observed_tracks o
    where o.active
      and o.cover_md5 is not null
      and o.last_rank is not null
      and o.isrc is not null
      and o.spotify_track_id is not null
    order by o.isrc, o.last_rank desc
  ),
  calc as (
    select
      b.*,
      h.pontos,
      case
        when h.pontos >= 2
         and (b.last_checked_at at time zone 'UTC')::date
             - (b.added_at at time zone 'UTC')::date >= 3
         and b.first_rank > 0
          then ((b.last_rank - b.first_rank)::numeric / b.first_rank) * 100
        else null
      end as variacao
    from base b
    cross join lateral (
      select count(*) as pontos
      from public.track_popularity_history hh
      where hh.track_uri = 'deezer:track:' || b.deezer_track_id
        and hh.rank is not null
    ) h
  ),
  escolhidas as (
    select *
    from calc
    -- Com movimento medido, manda a variação. Sem, manda o subsolo.
    order by variacao desc nulls last, last_rank asc
    limit p_limite
  )
  select jsonb_build_object(
    'medidas', (select count(*) from public.observed_tracks where active),
    'desde',   (select min(added_at)::date from public.observed_tracks),
    'tem_movimento', exists (select 1 from calc where variacao is not null and variacao > 0),
    'faixas', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'spotify_id', e.spotify_track_id,
            'title',      e.title,
            'artist',     e.artist_name,
            'md5',        e.cover_md5,
            'genre',      e.genre,
            'audiencia',  coalesce(e.last_popularity, 0),
            'variacao',   round(e.variacao, 1)
          )
          order by e.variacao desc nulls last, e.last_rank asc
        )
        from escolhidas e
      ),
      '[]'::jsonb
    )
  );
$$;

grant execute on function public.get_landing_observatory(integer) to anon, authenticated;
