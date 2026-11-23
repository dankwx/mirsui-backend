-- 050_salto_nas_faixas_salvas.sql
-- O aviso de salto no feed: a faixa que a pessoa salvou e mais subiu na semana.
--
-- (A 049 está reservada para a paginação por cursor da fila do banco.)
--
-- ------------------------------------------------------------
-- O QUE É
-- ------------------------------------------------------------
-- Quando uma faixa que a pessoa guardou sobe forte, o feed mostra a toupeira
-- com os riscos de susto: "Poison subiu de 9 para 19 nesta semana". É o
-- momento em que o "eu já ouvia" vira verdade, e até agora ninguém ficava
-- sabendo dele sem abrir a página da faixa.
--
-- ------------------------------------------------------------
-- DE ONDE VEM CADA NÚMERO
-- ------------------------------------------------------------
-- Tudo na escala 0-100 da página de faixa (popScore: rank do Deezer / 10.000).
--
--   agora      `observed_tracks.last_rank`, a última medição.
--   antes      o rank de 7 dias atrás. O histórico guarda só mudança (021),
--              então é o último ponto gravado até aquele dia.
--   salva_com  o rank no dia em que a pessoa salvou, pelo mesmo critério. Fica
--              null quando o Observatório ainda não media a faixa naquele dia,
--              que é o caso de quase todo save anterior a agosto de 2026.
--
-- `tracks.popularity` NÃO serve para "salva_com": os saves antigos gravaram a
-- popularidade do Spotify, outra escala, de outra empresa.
--
-- ------------------------------------------------------------
-- O QUE CONTA COMO SALTO
-- ------------------------------------------------------------
-- Pelo menos 5 pontos na semana E pelo menos 20% a mais de rank. Os 5 pontos
-- tiram o ruído de quem está no chão (de 0 para 1 é muito em porcentagem e
-- nada em gente); os 20% tiram o hit que oscila (de 85 para 90 é só ruído lá
-- em cima). Testado em 23/11/2026 com o token de cada uma das 24 pessoas que
-- têm save com ISRC: seis teriam aviso (Poison 9 → 19, Platinum Disco 21 → 26,
-- Algo Está Cambiando 24 → 29, Judia de Mim 11 → 16, That's It 65 → 84 e La
-- Recta Final 0 → 10), todas com "salva_com" null. Leva ~3 ms.
--
-- Volta uma linha só, a do maior salto. Sem salto, volta vazio e o feed não
-- mostra nada.
--
-- ------------------------------------------------------------
-- QUEM PODE CHAMAR
-- ------------------------------------------------------------
-- `security definer` porque lê o histórico do Observatório, que é fechado. A
-- autorização é `t.user_id = auth.uid()`: cada um só vê os próprios saves, e
-- sem token não casa linha nenhuma. Só `authenticated` executa.

create or replace function public.get_my_track_jump()
returns table (
  isrc        text,
  title       text,
  artist_name text,
  antes       integer,
  agora       integer,
  salva_em    timestamp,
  salva_com   integer
)
language sql
stable
security definer
set search_path = public
as $$
  with minhas as (
    -- uma linha por gravação medida; vale o save mais antigo da pessoa
    select distinct on (o.deezer_track_id)
      o.deezer_track_id, o.isrc, o.title, o.artist_name, o.last_rank,
      t.claimedat
    from public.tracks t
    join public.observed_tracks o on o.isrc = upper(t.isrc)
    where t.user_id = auth.uid()
      and t.isrc is not null
      and o.active
      and o.last_rank is not null
    order by o.deezer_track_id, t.claimedat
  ),
  medidas as (
    select
      m.*,
      (select h.rank
         from public.track_popularity_history h
        where h.track_uri = 'deezer:track:' || m.deezer_track_id
          and h.recorded_at <= now() - interval '7 days'
        order by h.recorded_at desc
        limit 1) as rank_semana,
      (select h.rank
         from public.track_popularity_history h
        where h.track_uri = 'deezer:track:' || m.deezer_track_id
          and h.recorded_at <= m.claimedat
        order by h.recorded_at desc
        limit 1) as rank_salva
    from minhas m
  ),
  pontos as (
    select
      isrc, title, artist_name, claimedat, last_rank, rank_semana,
      least(100, greatest(0, round(rank_semana / 10000.0)))::int as antes,
      least(100, greatest(0, round(last_rank / 10000.0)))::int   as agora,
      -- `greatest` ignora null; sem o case, "não medida no dia" virava 0
      case when rank_salva is not null
        then least(100, greatest(0, round(rank_salva / 10000.0)))::int
      end as salva_com
    from medidas
    where rank_semana is not null
  )
  select isrc, title, artist_name, antes, agora, claimedat, salva_com
  from pontos
  where agora - antes >= 5
    and last_rank >= rank_semana * 1.2
  order by agora - antes desc, last_rank desc
  limit 1
$$;

revoke all on function public.get_my_track_jump() from public, anon;
grant execute on function public.get_my_track_jump() to authenticated;
