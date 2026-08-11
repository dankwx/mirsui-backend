-- 010_observatorio_isrc.sql
-- Marca de "já tentei descobrir o ISRC desta faixa".
--
-- MOTIVO
-- O ISRC é a única ponte entre o id do Deezer (onde o Observatório mede) e o id
-- do Spotify (como as páginas do site são endereçadas: /track/[spotifyId]). O
-- endpoint de chart não devolve esse campo — só /track/{id} devolve —, então as
-- faixas que entram por chart nascem sem ISRC e precisam de uma requisição
-- dedicada para ganhá-lo.
--
-- Sem esta coluna, a fila dessa etapa seria "isrc is null", e toda faixa que o
-- Deezer simplesmente não tem ISRC (acontece com lançamento independente e com
-- upload de gravadora pequena) voltaria para a fila todas as noites, para sempre,
-- empurrando as faixas ainda não tentadas para trás e travando o avanço.
--
-- Com a marca, a fila vira "nunca tentei". Uma faixa é consultada uma vez; se o
-- Deezer não tem ISRC para ela, sai da fila e o resto anda. Para forçar uma
-- nova rodada de tentativas basta zerar a coluna:
--   update public.observed_tracks set isrc_checked_at = null where isrc is null;

alter table public.observed_tracks
  add column if not exists isrc_checked_at timestamptz;

-- Fila da etapa de ISRC. Índice parcial: só interessa quem ainda não tem ISRC e
-- nunca foi tentado, que é um conjunto que encolhe até virar quase vazio.
create index if not exists observed_tracks_isrc_pendente_idx
  on public.observed_tracks (added_at)
  where active and isrc is null and isrc_checked_at is null;

-- Registra a tentativa, independente de ter achado ISRC ou não. É chamada com
-- todos os ids consultados na rodada; os que acharam já tiveram o isrc gravado
-- por record_observations().
create or replace function public.mark_isrc_checked(p_ids text[])
returns integer
language sql
as $$
  with marcadas as (
    update public.observed_tracks
    set isrc_checked_at = now()
    where deezer_track_id = any(p_ids)
    returning 1
  )
  select count(*)::integer from marcadas;
$$;

revoke all on function public.mark_isrc_checked(text[]) from public, anon, authenticated;
grant execute on function public.mark_isrc_checked(text[]) to service_role;
