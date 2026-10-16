-- 042_playlists_de_medicao.sql
-- As playlists do Deezer que a rodada lê para medir o catálogo.
--
-- ------------------------------------------------------------
-- POR QUE PLAYLIST
-- ------------------------------------------------------------
-- Uma página de `/playlist/{id}/tracks` traz o rank de 2.000 faixas numa
-- requisição, e o rank é o mesmo de `/track/{id}`: 489 de 489 conferidas, em
-- 22/09 e 16/10/2026. A rodada de 15/10/2026 gastou ~102 mil requisições só na
-- medição (28.202 álbuns + 73.834 faixas uma a uma) e durou 19,7 h.
--
-- O Deezer não aceita mais app novo, então quem cria as playlists é o
-- TuneMyMusic, a partir de um CSV com as faixas do catálogo, no perfil do dono
-- do Mirsui. Ele casa por ISRC e às vezes escolhe outra edição da mesma
-- música: em 16/10/2026, 86,7% vieram com o nosso id e 13,2% com outro. Por
-- isso a rodada casa SÓ pelo id (`medirPorPlaylist`), e o que não veio com o
-- próprio id segue pelo álbum e por /track, como antes.
--
-- Detalhes, testes e números em docs/medicao-por-playlist.md.
--
-- ------------------------------------------------------------
-- A TABELA
-- ------------------------------------------------------------
-- Só a lista do que ler e o que a última leitura achou. Quem cadastra é
-- `src/scripts/cadastrarPlaylists.ts`, que confere antes quantas faixas de cada
-- playlist são do catálogo. Desligar uma playlist é `active = false`; apagar
-- não desfaz nada que ela mediu.

create table if not exists public.measurement_playlists (
  deezer_playlist_id text        primary key check (deezer_playlist_id ~ '^[0-9]+$'),
  -- o título no Deezer quando foi cadastrada ("Mirsui 004", "My playlist 1")
  label              text,
  active             boolean     not null default true,
  added_at           timestamptz not null default now(),
  -- a última leitura inteira, quantas faixas ela trouxe e quantas da fila
  -- daquela noite foram medidas por ela
  last_read_at       timestamptz,
  last_tracks        integer,
  last_measured      integer,
  -- a última vez que não deu para ler a playlist inteira
  last_failed_at     timestamptz
);

comment on table public.measurement_playlists is
  'Playlists do Deezer que a etapa 3a da rodada lê para medir o catálogo (uma requisição por 2.000 faixas). Casamento só pelo id da faixa. Ver migration 042 e docs/medicao-por-playlist.md.';
comment on column public.measurement_playlists.last_measured is
  'Faixas da fila daquela noite medidas por esta playlist. Bem abaixo de last_tracks quer dizer que a playlist envelheceu: o catálogo desativou faixas ou o TuneMyMusic trocou edições.';

-- A lição da 030: RLS desde o create table. Sem política nenhuma: é tabela de
-- operação, só a service role lê e escreve.
alter table public.measurement_playlists enable row level security;
revoke all on public.measurement_playlists from anon, authenticated;
