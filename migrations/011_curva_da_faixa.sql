-- 011_curva_da_faixa.sql
-- Leitura do Observatório pela página de faixa.
--
-- A página é endereçada por id do Spotify e o Observatório mede por id do
-- Deezer; o ISRC é a ponte (ver migrations/010). Esta função recebe o ISRC que
-- a página já tem em mãos (vem de external_ids.isrc na resposta do Spotify) e
-- devolve a curva pronta.
--
-- É uma função e não duas queries do cliente por dois motivos:
--
-- 1. A escolha do id canônico precisa morar junto do dado. O Deezer mantém mais
--    de um id para a mesma gravação — o single e a faixa do álbum, ou catálogos
--    regionais distintos. São 5 casos em 2.602 hoje (0,2%), e cada id tem série
--    própria. Sem critério, a página sortearia entre a entrada que as pessoas
--    tocam e uma duplicata parada. O desempate é `last_rank desc`: o rank do
--    Deezer reflete audiência, então o id de maior rank é o que vale.
--
-- 2. Uma ida ao banco em vez de duas. A página de faixa já fala com Spotify,
--    Deezer, YouTube e Supabase; não é lugar para somar round-trip.
--
-- SECURITY INVOKER: as duas tabelas têm policy de select público, então o papel
-- anon lê normalmente e a função não precisa de privilégio nenhum.

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
        select jsonb_agg(
                 jsonb_build_object(
                   'd', (h.recorded_at at time zone 'UTC')::date,
                   'r', h.rank
                 )
                 order by h.recorded_at
               )
        from public.track_popularity_history h
        where h.track_uri = 'deezer:track:' || c.deezer_track_id
          and h.rank is not null
      ),
      '[]'::jsonb
    )
  )
  from canonica c;
$$;

-- Faixa que o Observatório ainda não viu simplesmente não retorna linha, e a
-- função devolve null. A página trata isso não renderizando o bloco.

grant execute on function public.get_track_curve(text) to anon, authenticated;
