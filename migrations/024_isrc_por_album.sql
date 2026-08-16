-- 024_isrc_por_album.sql
-- Item 5 de docs/analise-escala-apis-e-banco.md (§4.2), aplicado agora porque a
-- fase 4 do plano de independência do Spotify o colocou no caminho crítico.
--
-- O QUE MUDOU DE CONTEXTO
-- A etapa de ISRC era "a ponte para o Spotify": um passo intermediário para um
-- passo que, por sua vez, dava página à faixa. Com o ISRC virando o ENDEREÇO
-- (migration 023), ela deixou de ser intermediária — é ela que dá página às
-- faixas novas. Um item que estava na fila de otimização virou o gargalo do
-- produto, e por isso passa na frente.
--
-- A CONTA
-- Hoje a etapa gasta 1 requisição por faixa em `/track/{id}` só para ler o
-- campo `isrc` — 3.065 requisições na fila atual. `/album/{id}/tracks` devolve
-- o álbum inteiro numa requisição, com ISRC e rank em todas as faixas
-- (medido: 14/14 em ambos os campos). A ~10-14 faixas por álbum, é ~10x menos.
--
-- O QUE FALTAVA PARA FAZER ISSO
-- Saber o id do álbum. A resposta do chart sempre trouxe `album.id` e nós
-- descartávamos — guardávamos só `album.title` e o md5 da capa. Esta migration
-- abre a coluna; src/lib/deezerCatalog.ts passa a preenchê-la a partir das
-- respostas que já chegam, sem nenhuma requisição a mais.
--
-- Faixa sem álbum conhecido continua caindo no caminho antigo, um a um. A
-- coluna vai se preenchendo sozinha a cada rodada de chart.

alter table public.observed_tracks
  add column if not exists deezer_album_id text;

comment on column public.observed_tracks.deezer_album_id is
  'Álbum da faixa no Deezer. Permite resolver ISRC em lote por /album/{id}/tracks — ver migrations/024.';

-- A fila da etapa de ISRC, agora agrupável por álbum. Índice parcial sobre um
-- conjunto que só encolhe, no mesmo espírito de observed_tracks_spotify_pendente_idx.
create index if not exists observed_tracks_isrc_pendente_album_idx
  on public.observed_tracks (deezer_album_id)
  where active and isrc is null and isrc_checked_at is null;

-- ---------------------------------------------------------------------------
-- record_observations aceita o id do álbum
-- ---------------------------------------------------------------------------
-- Única mudança de comportamento: mais uma coluna no upsert, com a MESMA regra
-- das outras de metadado — `coalesce(excluded, o)`, ou seja, só melhora e nunca
-- piora. Uma resposta que não traga o álbum não apaga o que já estava lá.
--
-- A regra de escrita do histórico (só grava quando o rank muda, migration 021)
-- continua idêntica.

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
        r->>'deezer_album_id'    as deezer_album_id,
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
      deezer_track_id, deezer_artist_id, deezer_album_id, isrc, title,
      artist_name, album_name, cover_md5, genre, source_list,
      first_rank, first_popularity, last_rank, last_popularity, last_checked_at
    )
    select
      deezer_track_id, deezer_artist_id, deezer_album_id, isrc, title,
      artist_name, album_name, cover_md5, genre, source_list,
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
      album_name      = coalesce(excluded.album_name, o.album_name),
      deezer_album_id = coalesce(excluded.deezer_album_id, o.deezer_album_id)
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
  select (select count(*) from historico) + 0 * (select count(*) from catalogo)
  into v_pontos;

  return v_pontos;
end $$;

comment on function public.record_observations(jsonb) is
  'Grava catálogo + histórico. O histórico só recebe linha quando o rank difere do último ponto gravado (migration 021). Retorna o número de MUDANÇAS gravadas, não de medições.';

revoke all on function public.record_observations(jsonb) from public, anon, authenticated;
grant execute on function public.record_observations(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Backfill do que já dá para saber sem gastar requisição
-- ---------------------------------------------------------------------------
-- Faixas da mesma gravação (mesmo ISRC) que já têm álbum conhecido emprestam o
-- id para as que não têm. É pouco, mas é de graça — o resto se preenche sozinho
-- na próxima varredura de charts.
update public.observed_tracks alvo
set deezer_album_id = fonte.deezer_album_id
from public.observed_tracks fonte
where alvo.deezer_album_id is null
  and alvo.isrc is not null
  and fonte.isrc = alvo.isrc
  and fonte.deezer_album_id is not null;
