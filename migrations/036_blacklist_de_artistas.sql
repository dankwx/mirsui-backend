-- 036 — Blacklist de artistas e desativação do catálogo não-musical
--
-- O QUE ISTO CONSERTA
-- A descoberta por álbum (ADR 002, migration 026) colhe a discografia de
-- artistas obscuros, e o único filtro sobre a candidata é o da
-- `catalogDiscovery.ts`: ter título, ter nome de artista e ter rank. Nada
-- olha o QUE a faixa é. O dial de obscuridade (`OBS_DESCOBERTA_MAX_FAS`,
-- artistas com até 50 mil fãs, do menos popular para cima) aponta exatamente
-- para onde mora o conteúdo não-musical: poucos fãs, discografia enorme.
--
-- Medido em 20/09/2026 sobre o dump de 03/09 (18.164 faixas ativas), com o
-- modelo de decisão jev-1.13 da TypeSafe, três perguntas por faixa (playback,
-- áudio funcional, fala), limiar 0,70:
--
--   503 faixas (2,77%) de conteúdo inequivocamente não-musical
--   430 delas (85%) vindas de SEIS artistas
--   300 de um álbum só: o Alcorão recitado inteiro
--
-- POR QUE `active = false` E NÃO `delete`
-- A linha guarda `first_rank`/`first_popularity`, que é a marca do dia em que
-- a faixa entrou e não se reconstrói. `active = false` já é o mecanismo que
-- tira a faixa da fila de medição (catalogSnapshot.ts:815), das sementes da
-- descoberta (catalogDiscovery.ts:236,531) e da gravação de id do Spotify
-- (tracks.ts:211). Reverter é um update.
--
-- POR QUE A BLACKLIST É POR ARTISTA
-- Desativar faixa não resolve: a caminhada volta no mesmo artista amanhã e
-- colhe os álbuns seguintes. O bloqueio precisa morar na fronteira. E é por
-- isso que ele é de graça — o modelo serviu para DESCOBRIR quem são; manter
-- a regra não custa chamada nenhuma.
--
-- RLS LIGADA DESDE O `create table`, que é a lição da 030.

create table if not exists public.blocked_artists (
  deezer_artist_id text primary key,
  artist_name      text,
  reason           text,
  blocked_at       timestamptz not null default now()
);

comment on table public.blocked_artists is
  'Artistas que a descoberta nunca deve colher: catálogo não-musical (recitação, frequências, playback, ruído). Ver migration 036.';

alter table public.blocked_artists enable row level security;
revoke all on public.blocked_artists from anon, authenticated;

insert into public.blocked_artists (deezer_artist_id, artist_name, reason) values
  ('1369595', 'Shaykh Ali Al-Hudhaify', '300/300 marcadas pelo jev-1.13'),
  ('302374481', 'Gama Waves 40Hz', '106/112 marcadas pelo jev-1.13'),
  ('1353501', 'Cheik Ali Ben Abderrahmane Hodayfi', '13/15 marcadas pelo jev-1.13'),
  ('1650022', 'Karaoke Star Explosion', '4/4 marcadas pelo jev-1.13'),
  ('12992573', 'Música de Ninar', '4/4 marcadas pelo jev-1.13'),
  ('9863678', 'S. N. Goenka', '3/3 marcadas pelo jev-1.13')
on conflict (deezer_artist_id) do nothing;

-- 1. Desativa TODAS as faixas dos artistas bloqueados. Vale para o catálogo de
--    hoje, não só para as faixas que estavam no dump: se a caminhada colheu
--    mais desses artistas depois de 03/09, elas caem aqui também.
update public.observed_tracks o
   set active = false
  from public.blocked_artists b
 where o.deezer_artist_id = b.deezer_artist_id
   and o.active;

-- 2. Faixas soltas: artistas que TÊM música real no catálogo e também
--    despejaram playback. O artista fica, a faixa sai. (Helo Abreu 29,
--    Sara Rodrigues 11, Lynk 4 10 — e o resto pingado.)
update public.observed_tracks
   set active = false
 where active
   and deezer_track_id in (
    '2405570555', '2814717752', '533024212', '1004295562', '3250874661', '3871706471',
    '2132742897', '3038216951', '2132742887', '2207598387', '3637565032', '2206595707',
    '2333337225', '2333337255', '2264095017', '2132742877', '2459807575', '2207598357',
    '1034479742', '2442218735', '2132742907', '2835905442', '2654596932', '2958077781',
    '1144359442', '2333337285', '2442218745', '2442218715', '3245200531', '4009450891',
    '1085384412', '3337204331', '1111338912', '2937453301', '2937453291', '2958077771',
    '2958077791', '2958077801', '2958077821', '2958077811', '2132742867', '2207598367',
    '2333337205', '2333337215', '2333337235', '2333337265', '3916610381', '2333337275',
    '2442218725', '3245200521', '2207598377', '3378325311', '2309192345', '692298232',
    '2579734292', '1712990757', '2923669881', '2923669981', '3484990691', '3484990681',
    '3484990701', '3484990741', '3484990731', '3484990721', '3484990771', '3484990761',
    '4184992412', '4184992422', '4184992402', '3484990711', '3484990751', '3401530041',
    '3095101971'
   );

-- 3. Tira os bloqueados da fronteira, senão a caminhada volta neles hoje à
--    noite e recomeça de `next_album_index`.
delete from public.discovery_artists d
 using public.blocked_artists b
 where d.deezer_artist_id = b.deezer_artist_id;

create index if not exists observed_tracks_artista_ativo_idx
  on public.observed_tracks (deezer_artist_id) where active;
