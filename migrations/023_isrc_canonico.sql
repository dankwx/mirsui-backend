-- 023_isrc_canonico.sql
-- O identificador do site passa a ser o ISRC.
-- Ver docs/plano-independencia-do-spotify.md, fase 1.
--
-- O PROBLEMA QUE ISTO RESOLVE
-- As páginas de faixa eram endereçadas pelo id do Spotify. O Observatório mede
-- 6.490 faixas por noite; só 1.388 (21,4%) tinham esse id. As outras 5.102 são
-- gravações que medimos todo dia e que não tinham página — não por falta de
-- dado nosso, mas porque uma API de terceiro não confirmou que elas existem no
-- mercado brasileiro dela.
--
-- Medição de 15/08/2026 contra este banco:
--
--   ativas                    6490
--   com isrc                  3425   <- ganham página imediatamente
--   com spotify_track_id      1388   <- tinham página
--   fila de isrc              3065   <- 6 min de job, e viram ~6.490
--   consultadas sem isrc         0   <- o Deezer nunca falhou em devolver ISRC
--
-- POR QUE ISRC E NÃO deezer_track_id
-- Trocar id do Spotify por id do Deezer só mudaria o problema de dono. O ISRC
-- é o código da GRAVAÇÃO, emitido pela indústria, e não pertence a plataforma
-- nenhuma: se um dia a fonte de medição mudar (MusicBrainz, Last.fm), as URLs
-- do site não mudam junto. Ele também já era a identidade interna de fato —
-- get_track_curve casa por ele, resolveTrack dos Stakes tenta ele primeiro.
-- Faltava só promovê-lo a endereço.
--
-- OS TRÊS FORMATOS NÃO COLIDEM
-- Verificado contra os 3.425 ISRCs reais deste banco, não por dedução:
--
--   casam ^[A-Z]{2}[A-Z0-9]{3}[0-9]{7}$   3425  (100%)
--   casam ^[A-Za-z0-9]{22}$ (Spotify)        0
--   casam ^[0-9]+$          (Deezer)         0
--
-- Por isso a rota /track/[id] distingue os três por regex e redireciona os
-- antigos: link mandado no WhatsApp há três meses continua abrindo.

-- ---------------------------------------------------------------------------
-- 1. O acervo ganha a identidade da gravação
-- ---------------------------------------------------------------------------
-- `tracks.track_uri` NÃO muda. É a chave de todo o sistema de salvar/
-- reivindicar (position, contadores do feed, savers_count, get_track_save_counts,
-- unique_user_track_url) e o valor é uma chave opaca — chave opaca não precisa
-- significar nada. Migrar as 46 linhas do acervo real seria risco alto no único
-- dado insubstituível do produto, para trocar uma chave opaca por outra.
--
-- O que resolve o casamento com o Observatório é esta coluna ao lado. A partir
-- daqui a contagem é por gravação: a mesma faixa salva como 'spotify:track:X'
-- antes e como 'isrc:Y' depois conta no mesmo lugar, em vez de virar dois
-- contadores paralelos e duas "primeiras pessoas a salvar".

alter table public.tracks
  add column if not exists isrc text;

comment on column public.tracks.isrc is
  'Identidade da gravação. Preenchida no save (src/routes/claims.ts) e retroativamente pela ponte do Observatório. track_uri continua sendo a chave opaca — ver migrations/023.';

create index if not exists tracks_isrc_idx
  on public.tracks (isrc)
  where isrc is not null;

-- Backfill pelo único caminho que existe sem chamar API nenhuma: as faixas do
-- acervo cujo id do Spotify o job já resolveu. O que não casar fica null e
-- continua sendo identificado por track_uri, como sempre foi.
update public.tracks t
set isrc = o.isrc
from public.observed_tracks o
where t.isrc is null
  and o.isrc is not null
  and o.spotify_track_id is not null
  and t.track_uri = 'spotify:track:' || o.spotify_track_id;

-- ---------------------------------------------------------------------------
-- 2. Índice da resolução de URL antiga
-- ---------------------------------------------------------------------------
-- /track/<idDoSpotify> vira /track/<ISRC> por consulta LOCAL a esta coluna —
-- sem chamar o Spotify, que é o ponto inteiro do plano. Isso passa a acontecer
-- a cada visita de link antigo, então deixa de ser varredura de job e vira
-- consulta de request: merece índice próprio.
--
-- O índice que já existia (observed_tracks_spotify_pendente_idx) cobre o
-- conjunto oposto — as que ainda NÃO têm id — e não serve aqui.
create index if not exists observed_tracks_spotify_id_idx
  on public.observed_tracks (spotify_track_id)
  where spotify_track_id is not null;

-- ---------------------------------------------------------------------------
-- 3. A Pilha passa a linkar por ISRC
-- ---------------------------------------------------------------------------
-- Só troca o campo devolvido: 'spotify_id' -> 'isrc'. O corpo da seleção não
-- muda (a Pilha já exigia isrc não nulo para deduplicar por gravação), mas o
-- efeito é que as peças que apareciam sem link — porque o Spotify não tinha
-- aquela gravação no mercado BR — passam a abrir.

create or replace function public.get_pile_tracks(p_por_genero integer default 6)
returns jsonb
language sql
stable
as $$
  with canonicas as (
    -- Uma linha por gravação. O Deezer mantém a mesma faixa sob mais de um id
    -- (single e álbum); sem isto a mesma capa apareceria duas vezes na pilha.
    select distinct on (o.isrc) o.*
    from public.observed_tracks o
    where o.active
      and o.cover_md5 is not null
      and o.last_rank is not null
      and o.isrc is not null
    order by o.isrc, o.last_rank desc
  ),
  amostra as (
    select c.*,
           row_number() over (
             partition by coalesce(c.genre, 'outros')
             -- Pseudo-aleatório ESTÁVEL: espalha dentro do gênero sem sortear de
             -- novo a cada request, então a página segue cacheável.
             order by md5(c.deezer_track_id)
           ) as n
    from canonicas c
  ),
  escolhidas as (
    select a.*, ntile(3) over (order by a.last_rank) as terco
    from amostra a
    where a.n <= p_por_genero
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',        e.deezer_track_id,
        'isrc',      e.isrc,
        'title',     e.title,
        'artist',    e.artist_name,
        'md5',       e.cover_md5,
        'genre',     coalesce(e.genre, 'outros'),
        'heat',      case e.terco when 3 then 'topo' when 2 then 'meio' else 'subsolo' end,
        'audiencia', coalesce(e.last_popularity, 0)
      )
      order by e.last_rank desc
    ),
    '[]'::jsonb
  )
  from escolhidas e;
$$;

grant execute on function public.get_pile_tracks(integer) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. A landing para de exigir o id do Spotify
-- ---------------------------------------------------------------------------
-- Esta é a linha que a migration 015 justificava assim: "Só entram faixas com
-- spotify_track_id: sem ele não há para onde linkar, e uma vitrine que não abre
-- é o problema que esta migration existe para resolver."
--
-- A justificativa era correta e deixou de valer: agora HÁ para onde linkar.
-- O filtro saiu, e com ele o viés que ele criava — a vitrine mostrava as
-- maiores altas ENTRE as 1.388 que o Spotify confirmou, e não entre as 6.490
-- que medimos. As faixas mais obscuras são justamente as que o Spotify menos
-- resolve, e são exatamente a tese do produto ("antes de estourar").

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
            'isrc',       e.isrc,
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

-- ---------------------------------------------------------------------------
-- 5. Atividade recente aponta para o endereço canônico
-- ---------------------------------------------------------------------------
-- `track_id` desta função sempre foi "o que vai depois de /track/ na URL". Era
-- o id espremido de `track_uri`, o que dava link quebrado para toda linha que
-- não fosse `spotify:track:%` — inclusive as novas, salvas como `isrc:<ISRC>`.
-- Agora o ISRC vem na frente e o recorte do uri fica como último recurso.

create or replace function public.get_claimed_tracks_details()
returns table(
  username character varying,
  avatar_url character varying,
  claimed_at timestamp without time zone,
  track_title character varying,
  artist_name character varying,
  claim_message text,
  track_id text
)
language sql
as $$
    select
      p.username,
      p.avatar_url,
      t.claimedat as claimed_at,
      t.track_title,
      t.artist_name,
      t.claim_message,
      coalesce(
        t.isrc,
        case
          when t.track_uri like 'spotify:track:%'
            then substring(t.track_uri from 'spotify:track:(.+)')
          when t.track_uri like 'isrc:%'
            then substring(t.track_uri from 'isrc:(.+)')
        end
      ) as track_id
    from public.tracks as t
    join public.profiles as p on t.user_id = p.id
    where t.claimedat is not null
    order by t.claimedat desc
    limit 10;
$$;
