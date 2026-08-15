-- 016_storage_fechado.sql
-- Fecha a escrita anônima no Storage.
--
-- O PROBLEMA
-- `storage.objects` tinha três policies permissivas, todas para o papel
-- `public` (ou seja, incluindo `anon` — a chave que está no bundle JS):
--
--   "Enable insert for all users only"    INSERT  with check (true)
--   "Enable update access for all users"  UPDATE  using (true) with check (true)
--   "Enable update for all users only"    UPDATE  using (true) with check (true)
--
-- E os dois buckets estavam sem limite de tamanho e sem allowlist de MIME.
-- Com isso, qualquer pessoa sem login conseguia:
--
--   1. sobrescrever o avatar de qualquer usuário — o caminho é previsível
--      (`user-profile-images/<uuid>/profile-picture`, e o uuid vem na API
--      pública de perfis);
--   2. trocar a capa de qualquer playlist;
--   3. subir arquivo de qualquer tamanho, usando o projeto como hospedagem;
--   4. hospedar HTML/SVG em tqprioqqitimssshcrcr.supabase.co — a MESMA origem
--      da API REST e do Auth. Um SVG com <script> ali roda com acesso ao
--      storage de sessão daquela origem. Esse é o item grave.
--
-- Auditoria dos objetos existentes antes desta migration: 12 arquivos, todos
-- image/jpeg ou image/png, nenhum acima de 4MB, nada de HTML/SVG. O buraco
-- estava aberto mas não foi explorado.
--
-- O QUE JÁ EXISTIA E ESTÁ CERTO
-- `playlist-thumbnails` já tinha as três policies escopadas por dono
-- ("Users can upload/update/delete their playlist thumbnails"), no formato
-- `(storage.foldername(name))[1] = auth.uid()::text`. Elas nunca pegavam,
-- porque o front subia em `playlists/<id>/thumbnail` — a primeira pasta era a
-- string "playlists", que nunca é igual a um uuid. Ou seja: a policy certa
-- estava lá, o caminho é que não batia, e o upload passava pela policy aberta.
-- O front agora sobe em `<auth.uid()>/playlists/<id>/thumbnail` e essas
-- policies passam a valer de verdade. Por isso esta migration não as recria.
--
-- O QUE MUDA
-- * As três policies abertas caem. Não sobra escrita para `anon`.
-- * `user-profile-images` fica sem NENHUMA policy de escrita: o upload de avatar
--   agora passa por POST /profiles/:id/avatar, que usa a service role (ignora
--   RLS) depois de conferir que request.user.id === :id. O front chama esse
--   endpoint via /api/profiles/[id]/avatar em vez de falar com o bucket.
-- * A policy de SELECT `true` vira uma lista explícita dos dois buckets
--   públicos. Efeito prático hoje é zero (os dois são public = true e são
--   servidos pelo endpoint /object/public, que nem passa por RLS), mas evita
--   que um bucket privado criado amanhã nasça legível por todo mundo.
-- * Os buckets ganham teto de 5MB e allowlist de MIME sem SVG. O MIME é
--   declarado por quem sobe, então isso não impede um HTML disfarçado de PNG —
--   mas o Storage devolve o arquivo com o Content-Type declarado, e o navegador
--   não executa `image/png` como página. É o que corta o item 4.
--
-- O maior arquivo hoje tem 3,9MB, então o teto de 5MB não quebra nada existente.

-- 1. As policies de escrita abertas --------------------------------------------

drop policy if exists "Enable insert for all users only"   on storage.objects;
drop policy if exists "Enable update access for all users" on storage.objects;
drop policy if exists "Enable update for all users only"   on storage.objects;

-- 2. Leitura: dos dois buckets públicos, não de qualquer um --------------------

drop policy if exists "Enable read access for all users" on storage.objects;
drop policy if exists "storage_select_buckets_publicos" on storage.objects;

create policy "storage_select_buckets_publicos"
  on storage.objects for select
  using (bucket_id in ('user-profile-images', 'playlist-thumbnails'));

-- 3. Teto de tamanho e allowlist de MIME ---------------------------------------
-- image/svg+xml fica de fora de propósito: SVG é XML, aceita <script>, e seria
-- servido a partir da origem do Supabase.

update storage.buckets
   set file_size_limit = 5242880, -- 5MB
       allowed_mime_types = array[
         'image/jpeg',
         'image/png',
         'image/webp',
         'image/gif'
       ]
 where id in ('user-profile-images', 'playlist-thumbnails');
