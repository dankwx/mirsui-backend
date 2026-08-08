-- 007_backfill_track_uri.sql
-- APLICADO em 08/08/2026 no projeto soundsage.
--
-- 21 salvamentos de 2024-2025 tinham track_url mas não track_uri. Como salvar,
-- contar e deduplicar passaram a ser por track_uri (ver 006), essas linhas
-- ficariam invisíveis para o produto: sem botão de salvar e contando 1 cada,
-- mesmo quando eram a mesma música que outra linha. Eram 21 de 46 — quase
-- metade do feed.
--
-- O uri é derivável do url: https://open.spotify.com/track/<id>?si=... vira
-- spotify:track:<id>. Conferido antes de aplicar: os 21 produziram um id
-- base62 de 22 chars, e 7 se juntaram a músicas que já existiam.

-- Schema separado de propósito: uma tabela de backup em `public` ficaria
-- legível pela API do PostgREST.
create schema if not exists backup;

create table if not exists backup.tracks_antes_007 as
select id, track_uri, position, discover_rating, now() as salvo_em
from public.tracks;

-- 1. Preenche o uri a partir do url.
update public.tracks
set track_uri = 'spotify:track:' || regexp_replace(split_part(track_url, '?', 1), '^.*/', '')
where track_uri is null
  and track_url is not null
  and 'spotify:track:' || regexp_replace(split_part(track_url, '?', 1), '^.*/', '')
      ~ '^spotify:track:[A-Za-z0-9]{22}$';

-- 2. Recalcula position (e discover_rating, que deriva dela).
--
-- Com o uri preenchido, linhas que diziam "1ª a salvar" passam a dividir a
-- mesma música com outras — 9 delas ficariam mentindo o ordinal. A posição é
-- a ordem de claimedat dentro do track_uri, que é a mesma regra que
-- tracks/claim aplica ao inserir (count + 1). Empate desempata por id.
--
-- discover_rating repete a fórmula de routes/claims.ts:
--   100 - popularity + 100 / position
--
-- O `is distinct from` limita a escrita às linhas que realmente mudaram.
with recalc as (
  select
    id,
    row_number() over (partition by track_uri order by claimedat, id)::int as pos
  from public.tracks
  where claimedat is not null
    and track_uri is not null
)
update public.tracks t
set position = r.pos,
    discover_rating = 100 - coalesce(t.popularity, 0) + 100.0 / r.pos
from recalc r
where t.id = r.id
  and t.position is distinct from r.pos;

-- RESULTADO
-- 0 linhas sem track_uri · 0 posições inconsistentes · 22 -> 35 músicas únicas
-- reconhecidas · 9 músicas passaram a ter 2+ salvamentos.
--
-- PENDÊNCIA CONHECIDA
-- O backfill expôs 1 duplicata real: o mesmo usuário salvou "Instant Crush"
-- (spotify:track:2cGxRwrMyEAp8dEbuZaVv6) duas vezes — ids 38 (mai/2025) e 107
-- (out/2025). Passou porque o check de duplicata em tracks/claim compara
-- track_uri, que era null na linha antiga. Não foi removida: é dado de
-- usuário e a decisão não é do migration. Para juntar, apagar a linha 38 e
-- rodar de novo o passo 2.
--
-- O backup pode ser descartado quando não fizer mais falta:
--   drop table backup.tracks_antes_007;
