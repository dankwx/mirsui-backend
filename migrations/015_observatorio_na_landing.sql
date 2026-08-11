-- 015_observatorio_na_landing.sql
-- O Observatório na porta de entrada.
--
-- MOTIVO
-- A landing tem uma seção "Subindo na cena" alimentada pela tabela `tracks`, ou
-- seja, por salvamentos: umas 30 faixas únicas hoje. Ao mesmo tempo o
-- Observatório mede 2.602 faixas por noite e não aparece em lugar nenhum. A
-- seção mais visível do site usa o dado mais magro que existe, enquanto o único
-- ativo que ninguém consegue copiar fica invisível.
--
-- ESTA FUNÇÃO MELHORA SOZINHA
-- O que se quer mostrar é "as que mais subiram". Isso exige duas medições, e
-- hoje existe uma só — a primeira noite foi 10/08/2026. Então:
--
--   sem histórico  -> devolve o SUBSOLO (menor rank primeiro), que é exatamente
--                     a ponta "antes de estourar" da tese, e não uma lista de
--                     hits que qualquer chart já dá.
--   com histórico  -> devolve as maiores altas, ordenadas por variação.
--
-- `tem_movimento` diz à interface qual das duas histórias contar, para o título
-- da seção nunca prometer tendência sem ter medido tendência.
--
-- O CORTE DE 3 DIAS
-- Não basta ter duas medições: elas precisam estar afastadas no tempo. O job
-- roda uma vez por dia, mas a fronteira de idempotência é o dia UTC — então uma
-- rodada às 21h e outra às 22h (horário de Brasília) caem em dias UTC
-- diferentes e geram dois pontos separados por uma hora. Sem este corte, a
-- landing anunciaria "subiu 7,6%" com base em ruído de poucas horas. Aconteceu
-- literalmente na primeira noite.
--
-- Só entram faixas com spotify_track_id: sem ele não há para onde linkar, e uma
-- vitrine que não abre é o problema que esta migration existe para resolver.

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
        when h.pontos >= 2 and h.dias >= 3 and h.rank_inicial > 0
          then ((b.last_rank - h.rank_inicial)::numeric / h.rank_inicial) * 100
        else null
      end as variacao
    from base b
    cross join lateral (
      select
        count(*) as pontos,
        -- distância em dias entre a primeira e a última medição
        (max(hh.recorded_at)::date - min(hh.recorded_at)::date) as dias,
        (array_agg(hh.rank order by hh.recorded_at asc))[1] as rank_inicial
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
