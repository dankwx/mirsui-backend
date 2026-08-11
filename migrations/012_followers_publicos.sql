-- 012_followers_publicos.sql
-- Libera a leitura de `followers` para visitante sem sessão.
--
-- MOTIVO
-- O conteúdo do Mirsui passou a ser aberto (ver middleware.ts no frontend):
-- faixa, artista, perfil, feed e acervo de uma pessoa abrem sem login. Só que
-- a policy de SELECT de `followers` era `auth.uid() is not null`, então o
-- visitante deslogado via todo perfil com zero seguidores e zero seguindo —
-- número errado, não número ausente, que é pior.
--
-- Quem segue quem é informação pública em qualquer site comparável (Letterboxd,
-- Last.fm, RYM). As demais tabelas que as páginas públicas leem já estavam
-- abertas para anon: profiles, tracks, favorites, track_comments e
-- profile_comments.
--
-- O QUE **NÃO** MUDA AQUI
-- `playlists` e `playlist_tracks` seguem visíveis só para o dono. Não existe
-- coluna `is_public` nessas tabelas, então abrir tudo publicaria conteúdo que
-- as pessoas criaram sem nunca terem escolhido tornar público. Isso é decisão
-- de produto, não de infraestrutura. Efeito prático hoje: em
-- `/library/<username>`, o visitante deslogado vê os achados (públicos) e uma
-- aba de playlists vazia. Para abrir, o caminho honesto é adicionar
-- `is_public boolean default false` e deixar a pessoa escolher.
--
-- INSERT/UPDATE/DELETE continuam intactos: seguir alguém segue exigindo sessão.

drop policy if exists "Allow logged-in read access" on public.followers;

create policy "followers_select_public"
  on public.followers for select
  using (true);
