-- 051_faro_do_perfil.sql
-- O Faro do perfil: quantos achados da pessoa subiram depois que ela salvou.
--
-- (A 049 continua reservada para a paginação por cursor da fila do banco.)
--
-- ------------------------------------------------------------
-- O QUE É
-- ------------------------------------------------------------
-- Os Termos já definiam o Faro como "o placar que mede quão cedo e com que
-- consistência você acerta", mas ele nunca teve número de verdade: o perfil
-- antigo mostrava "FARO TOP 14%" tirado de um hash do username, e o site
-- removeu. Agora ele sai do Observatório: um acerto é uma faixa salva que
-- subiu de audiência depois do save.
--
-- ------------------------------------------------------------
-- DE ONDE VEM CADA NÚMERO
-- ------------------------------------------------------------
-- Escala 0-100 da página de faixa (popScore: rank do Deezer / 10.000).
--
--   antes   o rank no dia do save (o último ponto do histórico até ali). Quase
--           nenhum save tem esse ponto, porque a faixa só entra na medição
--           depois de salva; aí vale a primeira medição depois do save. Para
--           os saves antigos ela é de agosto de 2026, então o acerto conta o
--           que subiu desde então, e nunca o que subiu antes: o erro só
--           deixa o Faro menor.
--   agora   `observed_tracks.last_rank`.
--
-- Acerto: pelo menos 5 pontos E 20% a mais de rank, a mesma régua do aviso de
-- salto (050). Cada gravação conta uma vez por pessoa, pelo save mais antigo.
--
--   medidos  achados da pessoa que o Observatório mede (tem `antes`)
--   acertos  desses, os que subiram
--
-- Em 23/11/2026: 24 pessoas com achado medido; a que mais acertou tinha 6
-- (de 18), cinco tinham 1 ou 2, e o resto 0.
--
-- ------------------------------------------------------------
-- QUEM PODE CHAMAR
-- ------------------------------------------------------------
-- O perfil é público, e o acervo dele também. A função devolve só as duas
-- contagens, então anon e authenticated executam. `security definer` porque o
-- histórico do Observatório é fechado.

create or replace function public.get_user_faro(user_uuid uuid)
returns table (
  medidos integer,
  acertos integer
)
language sql
stable
security definer
set search_path = public
as $$
  with achados as (
    select distinct on (o.deezer_track_id)
      o.deezer_track_id, o.last_rank, t.claimedat
    from public.tracks t
    join public.observed_tracks o on o.isrc = upper(t.isrc)
    where t.user_id = user_uuid
      and t.isrc is not null
      and o.active
      and o.last_rank is not null
    order by o.deezer_track_id, t.claimedat
  ),
  medidas as (
    select
      a.last_rank,
      coalesce(
        (select h.rank
           from public.track_popularity_history h
          where h.track_uri = 'deezer:track:' || a.deezer_track_id
            and h.recorded_at <= a.claimedat
          order by h.recorded_at desc
          limit 1),
        (select h.rank
           from public.track_popularity_history h
          where h.track_uri = 'deezer:track:' || a.deezer_track_id
            and h.recorded_at > a.claimedat
          order by h.recorded_at
          limit 1)
      ) as rank_antes
    from achados a
  )
  select
    count(*)::int as medidos,
    count(*) filter (
      where least(100, greatest(0, round(last_rank / 10000.0)))
          - least(100, greatest(0, round(rank_antes / 10000.0))) >= 5
        and last_rank >= rank_antes * 1.2
    )::int as acertos
  from medidas
  where rank_antes is not null
$$;

revoke all on function public.get_user_faro(uuid) from public;
grant execute on function public.get_user_faro(uuid) to anon, authenticated;
