-- 025_cadencia_adaptativa.sql
-- Item 4 da análise de escala: a rodada deixa de ter o tamanho do catálogo.
-- Ver docs/analise-escala-apis-e-banco.md, seções 5.1 e 9.
--
-- O PROBLEMA
-- A fila da etapa 3 é "tudo que está ativo e ainda não medi hoje", sem teto
-- (OBS_LIMITE_MEDICAO = Infinity por padrão). Dobrou o catálogo, dobrou a noite:
-- é O(N), e é a razão de OBS_MAX_CATALOGO existir. Como 91,9% das medições
-- consecutivas leem o mesmo rank, a maior parte dessas requisições existe para
-- descobrir que nada mudou.
--
-- A REGRA NOVA
-- Cada faixa ganha uma BANDA de cadência. Só é medida quem está vencida para a
-- própria banda, e a rodada para quando o ORÇAMENTO acaba — não quando o
-- catálogo acaba.
--
--   banda   critério                                              cadência
--   ------- ----------------------------------------------------- --------
--   quente  stake ativo, salva por alguém, entrou há < 30 dias,     1 dia
--           ou o último movimento foi de subida e é recente
--   morna   teve movimento (qualquer) nos últimos 30 dias           7 dias
--   fria    nada disso                                             14 dias
--
-- A ARITMÉTICA (é o parâmetro da banda fria que manda, não os outros)
--
--   custo/dia = 0,05N + 0,25N/7 + 0,70N/C_fria
--
--   C_fria = 30  ->  0,109N  ->  9,2x mais catálogo pelo mesmo orçamento
--   C_fria = 14  ->  0,136N  ->  7,4x      <- o padrão desta migration
--   C_fria =  7  ->  0,186N  ->  5,4x
--
-- 30 dias é o número da seção 5.1 e rende mais. O padrão aqui é 14 porque a
-- faixa fria é onde mora a obscura que ninguém tocou AINDA e que está prestes a
-- estourar — exatamente a tese do produto. Ela é promovida a quente na primeira
-- medição que detectar a subida, então não se perde a subida; perde-se o COMEÇO
-- dela, e a janela cega é o tamanho da cadência fria. Cortar de 30 para 14 custa
-- 20% do ganho e corta a janela cega pela metade. É um env, não um dogma:
-- OBS_CADENCIA_FRIA.
--
-- O QUE ISTO NÃO MUDA HOJE (medido em 16/08/2026, antes de aplicar)
--
--   ativas                                6490
--   entraram entre 10/08 e 15/08          6490   <- 100% do catálogo
--   com histórico de mais de 30 dias         0
--
-- O catálogo inteiro tem menos de sete dias, então "entrou há < 30 dias" torna
-- TODA faixa quente e a cadência é um no-op na primeira noite. Isso é o
-- comportamento correto, não um bug: a economia aparece conforme o catálogo
-- envelhece, e o log da rodada passa a mostrar a distribuição real das bandas
-- toda noite (quente/morna/fria), que é o número que a seção 5.1 supôs em
-- 5%/25%/70% sem poder medir.
--
-- A DÍVIDA QUE A 021 DEIXOU MARCADA
-- A gravação por delta assume que "sem linha no dia" significa "medi e não
-- mudou". Com cadência isso deixa de valer: faixa fria passa 14 dias sem
-- medição, e preencher esse intervalo seria invenção — justamente o que a
-- migration 009 proíbe. Resolvido aqui por `measured_gap_days`: cada linha de
-- mudança passa a carregar a largura da janela em que a mudança pode ter
-- acontecido, e get_track_curve devolve essas janelas em `lacunas`.

-- ---------------------------------------------------------------------------
-- 1. O catálogo ganha banda, origem e memória do último movimento
-- ---------------------------------------------------------------------------
-- `last_change_at` e `prev_rank` existem para a banda ser calculada num scan de
-- observed_tracks só. Sem eles, classificar 1M de faixas exigiria 1M de buscas
-- no histórico toda noite — trocar O(N) de API por O(N) de banco não é progresso.

alter table public.observed_tracks
  add column if not exists origin_list      text,
  add column if not exists last_change_at   timestamptz,
  add column if not exists prev_rank        integer,
  add column if not exists cadence_band     text,
  add column if not exists cadence_days     smallint,
  add column if not exists cadence_priority smallint;

comment on column public.observed_tracks.origin_list is
  'Como a faixa ENTROU no Observatório (chart:N, acervo, radio:N). Imutável. source_list virou o estado ATUAL e é promovido a acervo quando alguém salva a faixa — ver migration 025.';

comment on column public.observed_tracks.last_change_at is
  'Quando o rank mudou pela última vez. Mantido por record_observations, não pelo relógio da medição: medir e não mudar não mexe aqui.';

comment on column public.observed_tracks.prev_rank is
  'Rank imediatamente anterior ao atual, na régua das MUDANÇAS. last_rank > prev_rank é "subindo".';

comment on column public.observed_tracks.cadence_band is
  'quente | morna | fria. Recalculado por refresh_observatory_cadence() a cada rodada, gravado só quando muda.';

-- Backfill. `origin_list` recebe o que source_list guarda hoje, antes de
-- source_list poder ser promovido — é a única chance de preservar a origem, que
-- é o que a migration 009 queria dessa coluna ("saber se o Observatório está
-- enviesado para o que já é popular").
update public.observed_tracks
set origin_list = source_list
where origin_list is null;

-- last_change_at / prev_rank a partir do histórico já gravado. Como o histórico
-- guarda MUDANÇAS desde a 021, a última linha É a última mudança e a penúltima é
-- o rank anterior — não precisa reconstruir série densa nenhuma.
with mudancas as (
  select
    h.track_uri,
    h.rank,
    h.recorded_at,
    row_number() over (partition by h.track_uri order by h.recorded_at desc) as n
  from public.track_popularity_history h
  where h.rank is not null
    and h.track_uri like 'deezer:track:%'
),
resumo as (
  select
    replace(track_uri, 'deezer:track:', '')            as deezer_track_id,
    max(recorded_at) filter (where n = 1)              as ultima_mudanca,
    max(rank)        filter (where n = 2)              as rank_anterior
  from mudancas
  where n <= 2
  group by 1
)
update public.observed_tracks o
set last_change_at = coalesce(o.last_change_at, r.ultima_mudanca),
    prev_rank      = coalesce(o.prev_rank, r.rank_anterior)
from resumo r
where o.deezer_track_id = r.deezer_track_id
  and (o.last_change_at is null or o.prev_rank is null);

-- ---------------------------------------------------------------------------
-- 2. Salvou? então saiu do chart
-- ---------------------------------------------------------------------------
-- source_list era gravado na entrada e nunca mais mexido: faixa que entrou pelo
-- chart e foi salva depois continuava lida como 'chart:81'. Medido antes desta
-- migration: 2 faixas salvas estavam marcadas como chart/radio, e 34 marcadas
-- como 'acervo' contra 25 que realmente casam com o acervo hoje.
--
-- A promoção é só de mão única (para 'acervo') e de propósito. Quem salvou e
-- depois desfez continua marcado — mas a BANDA não depende desta coluna, e sim
-- do join vivo com `tracks` (seção 3). Ou seja: a coluna conta a história, o
-- join manda na cadência. Desmarcar aqui reescreveria a linha toda noite para
-- todo mundo que já desfez um save, que é escrita cara por informação que a
-- banda já obtém de graça.
--
-- O casamento é por ISRC quando existe, e por artista+título quando não —
-- mesmo par que a etapa 2 do job já usa (tracks não guardava ISRC antes da 023).

create or replace function public.promote_saved_observed_tracks()
returns integer
language sql
as $$
  with promovidas as (
    update public.observed_tracks o
    set source_list = 'acervo'
    where o.source_list is distinct from 'acervo'
      and exists (
        select 1
        from public.tracks t
        where (t.isrc is not null and t.isrc = o.isrc)
           or (lower(t.artist_name) = lower(o.artist_name)
           and lower(t.track_title)  = lower(o.title))
      )
    returning 1
  )
  select count(*)::integer from promovidas;
$$;

comment on function public.promote_saved_observed_tracks() is
  'Faixa salva por alguém passa a ser classificada como acervo, não importa por onde entrou. A origem fica em origin_list. Ver migration 025.';

revoke all on function public.promote_saved_observed_tracks() from public, anon, authenticated;
grant execute on function public.promote_saved_observed_tracks() to service_role;

-- Roda uma vez agora para o estado já ficar correto sem esperar a próxima noite.
select public.promote_saved_observed_tracks();

-- ---------------------------------------------------------------------------
-- 3. Classificação das bandas
-- ---------------------------------------------------------------------------
-- Escreve só quem mudou de banda, pelo mesmo motivo da 021: um UPDATE que toca
-- todas as linhas toda noite gera uma versão nova de cada tupla por dia, e a
-- 1M de faixas isso é bloat diário maior que o histórico que estamos economizando.
-- Banda muda raramente — é uma travessia de limiar, não um valor contínuo.
--
-- prioridade, que é o desempate dentro do orçamento:
--   0  interesse humano explícito (stake ativo ou salva)  -> quente
--   1  quente por movimento ou novidade                   -> quente
--   2  morna
--   3  fria
--
-- Prioridade 0 vem antes de 1 porque, quando o orçamento aperta, a faixa que
-- alguém está acompanhando é a última que pode ficar sem ponto no dia.

create or replace function public.refresh_observatory_cadence(
  p_cadencia_morna   integer default 7,
  p_cadencia_fria    integer default 14,
  p_janela_movimento integer default 30,
  p_janela_novidade  integer default 30
)
returns jsonb
language plpgsql
as $$
declare
  v_reclassificadas integer;
  v_distribuicao    jsonb;
begin
  with hoje as (select (now() at time zone 'UTC')::date as d),
  sinal as (
    select
      o.deezer_track_id,
      exists (
        select 1 from public.stakes s
        where s.status = 'ativa' and s.deezer_track_id = o.deezer_track_id
      ) as tem_stake,
      -- O join vivo, e não source_list: quem desfez o save volta a esfriar
      -- sozinho, sem precisar de escrita nenhuma.
      exists (
        select 1 from public.tracks t
        where (t.isrc is not null and t.isrc = o.isrc)
           or (lower(t.artist_name) = lower(o.artist_name)
           and lower(t.track_title)  = lower(o.title))
      ) as salva,
      (o.added_at at time zone 'UTC')::date
        > (select d from hoje) - p_janela_novidade as nova,
      -- `prev_rank is not null` é o que separa "mudou" de "entrou": toda faixa
      -- tem um primeiro ponto, e last_change_at sozinho contaria essa entrada
      -- como movimento — o catálogo inteiro nasceria morno em vez de frio.
      -- prev_rank só existe a partir da SEGUNDA gravação, que é uma mudança real.
      o.prev_rank is not null
        and (o.last_change_at at time zone 'UTC')::date
            > (select d from hoje) - p_janela_movimento as moveu,
      -- Rank do Deezer: maior é mais popular. Subindo = ganhando audiência.
      o.prev_rank is not null and o.last_rank > o.prev_rank as subindo
    from public.observed_tracks o
    where o.active
  ),
  classificada as (
    select
      deezer_track_id,
      case
        when tem_stake or salva          then 0
        when nova or (moveu and subindo) then 1
        when moveu                       then 2
        else                                  3
      end as prioridade
    from sinal
  ),
  final as (
    select
      deezer_track_id,
      prioridade,
      case prioridade when 0 then 'quente' when 1 then 'quente'
                      when 2 then 'morna'  else 'fria' end as banda,
      case prioridade when 0 then 1 when 1 then 1
                      when 2 then p_cadencia_morna else p_cadencia_fria end as dias
    from classificada
  ),
  gravadas as (
    update public.observed_tracks o
    set cadence_band     = f.banda,
        cadence_days     = f.dias,
        cadence_priority = f.prioridade
    from final f
    where o.deezer_track_id = f.deezer_track_id
      and (o.cadence_band     is distinct from f.banda
        or o.cadence_days     is distinct from f.dias
        or o.cadence_priority is distinct from f.prioridade)
    returning 1
  )
  select count(*)::integer from gravadas into v_reclassificadas;

  select jsonb_object_agg(cadence_band, n)
  into v_distribuicao
  from (
    select cadence_band, count(*) as n
    from public.observed_tracks
    where active
    group by cadence_band
  ) d;

  return jsonb_build_object(
    'reclassificadas', v_reclassificadas,
    'distribuicao',    coalesce(v_distribuicao, '{}'::jsonb)
  );
end $$;

comment on function public.refresh_observatory_cadence(integer, integer, integer, integer) is
  'Recalcula a banda de cadência de todas as faixas ativas e grava só as que mudaram de banda. Devolve a distribuição da noite. Ver migration 025.';

revoke all on function public.refresh_observatory_cadence(integer, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.refresh_observatory_cadence(integer, integer, integer, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. A fila com orçamento fixo
-- ---------------------------------------------------------------------------
-- Devolve APENAS quem está vencida para a própria banda, na ordem em que o
-- orçamento deve ser gasto, já cortada no limite. O job não vê mais o catálogo
-- inteiro — some junto a paginação de 1.000 linhas do PostgREST para esta fila.
--
-- "Vencida" é aritmética de dias inteiros em UTC, a mesma fronteira do índice de
-- idempotência (migration 009): dias_desde_a_última >= cadência. Para a banda
-- quente isso é "não foi medida hoje", que é exatamente a regra de antes — a
-- etapa 1 (charts) já gravou last_checked_at das faixas do chart quando esta
-- fila é lida, então elas saem daqui sozinhas, sem lista de exclusão.
--
-- Faixa sem banda (entrou depois do último refresh) é tratada como quente: o
-- viés seguro é medir a mais, não a menos.

create or replace function public.observatory_measurement_queue(p_limite integer)
returns table (
  deezer_track_id  text,
  deezer_artist_id text,
  deezer_album_id  text,
  title            text,
  artist_name      text,
  source_list      text,
  cadence_band     text
)
language sql
stable
as $$
  select
    o.deezer_track_id,
    o.deezer_artist_id,
    o.deezer_album_id,
    o.title,
    o.artist_name,
    o.source_list,
    coalesce(o.cadence_band, 'quente')
  from public.observed_tracks o
  where o.active
    and (
      o.last_checked_at is null
      or (now() at time zone 'UTC')::date - (o.last_checked_at at time zone 'UTC')::date
         >= coalesce(o.cadence_days, 1)
    )
  order by coalesce(o.cadence_priority, 0), o.last_checked_at asc nulls first
  limit greatest(p_limite, 0);
$$;

comment on function public.observatory_measurement_queue(integer) is
  'Fila da etapa 3 do Observatório: só quem venceu a própria cadência, na ordem de prioridade, cortada no orçamento da noite. Ver migration 025.';

revoke all on function public.observatory_measurement_queue(integer) from public, anon, authenticated;
grant execute on function public.observatory_measurement_queue(integer) to service_role;

-- Quantas faixas o orçamento deixou para trás. Existe separado porque a fila é
-- cortada no limite e, sem isto, um orçamento apertado seria SILENCIOSO — que é
-- o defeito que o comentário de OBS_LIMITE_* em catalogSnapshot.ts já nomeia.
create or replace function public.observatory_queue_size()
returns integer
language sql
stable
as $$
  select count(*)::integer
  from public.observed_tracks o
  where o.active
    and (
      o.last_checked_at is null
      or (now() at time zone 'UTC')::date - (o.last_checked_at at time zone 'UTC')::date
         >= coalesce(o.cadence_days, 1)
    );
$$;

revoke all on function public.observatory_queue_size() from public, anon, authenticated;
grant execute on function public.observatory_queue_size() to service_role;

-- A fila ordena por (prioridade, last_checked_at) sobre as ativas. O índice da
-- 009 cobria só last_checked_at.
drop index if exists public.observed_tracks_fila_idx;
create index if not exists observed_tracks_fila_idx
  on public.observed_tracks (cadence_priority, last_checked_at nulls first)
  where active;

-- ---------------------------------------------------------------------------
-- 5. A honestidade da curva: "não medi" != "medi e não mudou"
-- ---------------------------------------------------------------------------
-- Cada linha de mudança passa a guardar quantos dias se passaram desde a
-- medição ANTERIOR daquela faixa. Com medição diária isso é sempre 1 e não
-- afirma nada de novo. Com cadência fria de 14 dias, uma linha com gap = 14 diz:
-- "o rank era 400.000 quando olhei pela última vez, é 5.000 agora, e a virada
-- aconteceu em algum ponto destes 14 dias". Sem essa coluna, a curva desenharia
-- um degrau num dia específico que ninguém observou.
--
-- NULL = primeiro ponto da faixa (não existe medição anterior).

alter table public.track_popularity_history
  add column if not exists measured_gap_days smallint;

comment on column public.track_popularity_history.measured_gap_days is
  'Dias entre esta medição e a medição anterior da mesma faixa. 1 = observação diária. >1 = a mudança aconteceu em algum ponto da janela. NULL = primeiro ponto. Ver migration 025.';

-- O histórico existente foi todo coletado em regime diário (10/08 a 16/08), então
-- 1 é o valor verdadeiro para tudo que não é primeiro ponto — não é chute.
with primeiro as (
  select track_uri, min(recorded_at) as inicio
  from public.track_popularity_history
  where rank is not null
  group by track_uri
)
update public.track_popularity_history h
set measured_gap_days = 1
from primeiro p
where h.track_uri = p.track_uri
  and h.recorded_at > p.inicio
  and h.measured_gap_days is null;

-- ---------------------------------------------------------------------------
-- 6. record_observations v3
-- ---------------------------------------------------------------------------
-- Muda três coisas sobre a v2 (migration 021):
--   a) grava measured_gap_days na linha de mudança;
--   b) mantém last_change_at e prev_rank, que a banda consome;
--   c) não toca em source_list nem origin_list no conflito — a promoção para
--      'acervo' é da promote_saved_observed_tracks(), e um upsert de chart não
--      pode desfazê-la.
--
-- A regra de escrita do histórico não muda: linha só quando o rank difere do
-- último ponto JÁ GRAVADO. Continua comparando contra a tabela e não contra
-- last_rank, pelo motivo que a 021 documenta.
--
-- `mudou` chega ao ON CONFLICT por dentro de `excluded`: last_change_at é
-- calculado como now() ou NULL na própria SELECT, então `excluded.last_change_at
-- is not null` é o mesmo teste, sem precisar de uma segunda UPDATE. Duas CTEs
-- escrevendo na mesma linha da mesma tabela é indefinido no Postgres — uma das
-- duas seria silenciosamente descartada.

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
      deezer_track_id, deezer_artist_id, isrc, title, artist_name, album_name,
      cover_md5, genre, source_list, origin_list,
      first_rank, first_popularity, last_rank, last_popularity, last_checked_at,
      last_change_at, prev_rank
    )
    select
      m.deezer_track_id, m.deezer_artist_id, m.isrc, m.title, m.artist_name,
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

-- ---------------------------------------------------------------------------
-- 7. get_track_curve v3 — a curva passa a declarar o que não viu
-- ---------------------------------------------------------------------------
-- `series` sai IDÊNTICA à da 021, de propósito: o front é outro repositório e
-- não pode quebrar por causa desta migration. O que muda é aditivo:
--
--   cadencia_dias  de quantos em quantos dias esta faixa é medida hoje
--   lacunas        [{de, ate}] janelas em que houve mudança sem observação
--
-- Uma lacuna é a janela ABERTA entre a medição anterior e o dia da mudança: se
-- gap = 14 e a mudança foi gravada no dia 30, o valor novo pode ter aparecido em
-- qualquer dia de 17 a 29. O dia 30 é observado e fica de fora. gap <= 1 não
-- gera lacuna nenhuma, que é todo o histórico coletado até 16/08/2026.
--
-- O que isto NÃO resolve, e é honesto registrar: em trechos PLANOS (sem
-- mudança), continua-se sem saber quais dias foram medidos — só que ali o valor
-- é o mesmo nas duas pontas, e o único erro possível é esconder um pico que
-- subiu e voltou dentro da janela. É uma afirmação muito mais fraca do que
-- inventar a data de um degrau, que é o que esta seção corrige. Quem precisar da
-- resolução do trecho plano lê `cadencia_dias`.

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
    'cadencia_dias',   coalesce(c.cadence_days, 1),
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
    ),
    'lacunas', coalesce(
      (
        select jsonb_agg(
                 jsonb_build_object(
                   'de',  (h.recorded_at at time zone 'UTC')::date - (h.measured_gap_days - 1),
                   'ate', (h.recorded_at at time zone 'UTC')::date - 1
                 )
                 order by h.recorded_at
               )
        from public.track_popularity_history h
        where h.track_uri = 'deezer:track:' || c.deezer_track_id
          and h.rank is not null
          and h.measured_gap_days is not null
          and h.measured_gap_days > 1
      ),
      '[]'::jsonb
    )
  )
  from canonica c;
$$;

grant execute on function public.get_track_curve(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICAÇÃO (rodada em produção ao aplicar, 16/08/2026)
-- ---------------------------------------------------------------------------
--
-- 1. A curva não mudou para ninguém. `series` de todas as gravações com ISRC,
--    comparada por hash antes e depois:
--
--      isrcs conferidos      6.475
--      séries iguais         6.475
--      séries divergentes        0
--      hash get_landing_observatory   e66ca775... antes E depois
--
-- 2. Backfill:
--
--      com origin_list       6.490   (100%)
--      com last_change_at    6.490
--      com prev_rank         1.510   ← bate com as 1.510 que já mudaram de rank
--      gap = 1               1.575   ← todo o histórico foi coletado em regime diário
--      gap > 1                   0
--
-- 3. Promoção: 2 faixas salvas estavam marcadas como chart/radio e viraram
--    acervo — "Get Lucky" (origem chart:165) e "3:30 A.M" (origem
--    radio:234423431). origin_list preservou as duas origens.
--
-- 4. Classificação real: {"quente": 6490}. Cem por cento, porque o catálogo
--    inteiro entrou entre 10 e 15/08. Forçando as janelas para 3 dias, só para
--    ver as bandas separarem: quente 53,6% / morna 2,2% / fria 44,2%. A MORNA
--    QUASE NÃO EXISTE — a seção 5.1 supunha 25%. Faixa ou se mexe (e sobe, e
--    vira quente) ou não se mexe (e vira fria); a banda do meio é um estado de
--    transição, não uma população.
--
-- 5. record_observations v3, faixa de teste, três caminhos:
--      entrada nova       -> gap NULL, prev_rank NULL, last_change_at = hoje
--      mudou após 14 dias -> gap 14, prev_rank = rank antigo, linha gravada
--      medida sem mudar   -> 0 linhas, prev_rank e last_change_at intactos
--    E o upsert veio rotulado 'chart:999' sobre uma faixa já promovida:
--    source_list continuou 'acervo'. A promoção sobrevive à etapa 1.
--
-- 6. Curva com lacuna, na faixa de teste:
--      series  ... 15/08 r=1000, 16/08 r=5000   (degrau, como antes)
--      lacunas [{"de":"2026-08-03","ate":"2026-08-15"}]
--    O degrau continua desenhado no dia 16, mas agora acompanhado da declaração
--    de que aqueles treze dias não foram observados.
--
-- 7. Job de ponta a ponta, orçamento 3 numa fila de 3.410:
--      filaPorBanda {quente: 3}, adiadas 3407, falhas 0
--      log troca para "orçamento esgotado, fila sobrou para amanhã"
--
-- Conferir de novo a qualquer momento:
--
--   select cadence_band, cadence_days, count(*)
--   from public.observed_tracks where active group by 1,2 order by 3 desc;
--   select public.observatory_queue_size();
-- ---------------------------------------------------------------------------
