-- 045_faixas_exportadas_para_playlist.sql
-- A marca por faixa da rotina das playlists de medição.
--
-- ------------------------------------------------------------
-- POR QUE
-- ------------------------------------------------------------
-- As playlists da 042 são montadas pelo TuneMyMusic a partir de um CSV com as
-- faixas do catálogo. Enquanto o catálogo cresce (~9 mil faixas por dia até o
-- teto de 500 mil), alguém precisa exportar as faixas novas, subir o CSV e
-- cadastrar as playlists que ele criar. E uma parte volta errada: em
-- 18/10/2026, 13,5% das 310 mil faixas do primeiro export vieram como outra
-- edição do mesmo ISRC ("trocadas"), que a rodada não usa, porque casa só pelo
-- id. Reenviar a trocada SEM o ISRC faz o TuneMyMusic casar pelo nome, e no
-- teste de 16/10 isso recuperou 25% com o nosso id.
--
-- Para isso cada faixa precisa de duas marcas: quando e como foi exportada, e
-- se a playlist a trouxe com o nosso id. É o que `src/scripts/rotinaDasPlaylists.ts`
-- lê e escreve. A rodada não toca nesta tabela.
--
-- ------------------------------------------------------------
-- A TABELA
-- ------------------------------------------------------------
-- Uma linha por faixa já exportada. `with_isrc` falso quer dizer que ela foi
-- reenviada pelo nome depois de voltar trocada: dali não sai mais reenvio.
-- `came_back` é o resultado da última conferência contra a playlist do
-- `playlist_label`; nulo é "ainda não conferida".

create table if not exists public.playlist_export_tracks (
  deezer_track_id text        primary key,
  -- o nome da playlist no CSV ("Mirsui 157", "Mirsui trocadas 03")
  playlist_label  text        not null,
  exported_at     timestamptz not null default now(),
  -- o ISRC que foi no CSV; nulo quando foi pelo nome. É com ele que a
  -- conferência separa "trocada" (veio outra edição deste ISRC) de "nao_veio".
  isrc            text,
  with_isrc       boolean     not null,
  came_back       text        check (came_back in ('id', 'ilegivel', 'trocada', 'nao_veio')),
  checked_at      timestamptz
);

create index if not exists playlist_export_tracks_label_idx
  on public.playlist_export_tracks (playlist_label);

comment on table public.playlist_export_tracks is
  'Faixas exportadas para as playlists de medição (042) e o que a playlist trouxe. Escrita só por src/scripts/rotinaDasPlaylists.ts. Ver migration 045 e docs/medicao-por-playlist.md.';
comment on column public.playlist_export_tracks.came_back is
  'id: veio com o nosso id; ilegivel: veio com o nosso id e readable=false; trocada: veio outra edição com o mesmo ISRC; nao_veio: nada. Nulo: ainda não conferida.';

-- Como a 042: RLS desde o create table e só a service role.
alter table public.playlist_export_tracks enable row level security;
revoke all on public.playlist_export_tracks from anon, authenticated;
