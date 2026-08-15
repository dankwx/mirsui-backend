-- 017_youtube_cache_sem_sobrescrita.sql
-- Tira de `cache_youtube_video` o poder de sobrescrever entrada existente.
--
-- O PROBLEMA
-- A função é SECURITY DEFINER e está liberada para `anon` (ver
-- 002_youtube_cache.sql). Ela valida o FORMATO dos dois ids — 22 chars base62
-- para o Spotify, 11 para o YouTube — e não valida mais nada. O `on conflict
-- do update` fazia o resto: qualquer pessoa sem login podia apontar qualquer
-- faixa do Spotify para qualquer vídeo do YouTube, e a troca valia para todo
-- mundo que abrisse aquela faixa depois.
--
-- Validar formato não é validar autorização. O formato batia; a afirmação
-- ("este vídeo é esta música") é que não tinha como ser conferida.
--
-- POR QUE NÃO SIMPLESMENTE REVOGAR DO ANON
-- Quem popula o cache hoje é o Server Component da página de faixa
-- (app/(dashboard)/track/[id]/page.tsx no front), que roda com a sessão de
-- quem está vendo — ou seja, `anon` para visitante deslogado, que é o caso
-- comum numa página pública. Revogar aí faria o cache nunca mais ser escrito
-- pelo front, e cada visita a uma faixa não cacheada queimaria 100 unidades da
-- cota diária de 10k da YouTube Data API.
--
-- O QUE MUDA
-- `on conflict do update` vira `on conflict do nothing`. Continua qualquer um
-- podendo PREENCHER um vazio, mas ninguém consegue mais TROCAR o que já está
-- lá. Isso mata o ataque que importa: repontar uma faixa que já tem público.
--
-- O QUE SOBRA
-- Um atacante ainda pode envenenar uma faixa que ninguém abriu ainda, chegando
-- antes do primeiro visitante de verdade. Some o `do update` e some também o
-- conserto automático — por isso o backend ganhou caminho próprio de correção:
-- `resolveYouTubeVideoId` em src/routes/tracks.ts agora grava com a service
-- role direto na tabela (que não tem policy de INSERT/UPDATE, então só a
-- service role escreve), e essa via pode sobrescrever. Para consertar uma
-- entrada envenenada, basta uma chamada ao backend naquela faixa.
--
-- Fechar os 100% exigiria que só quem realmente fez a busca no YouTube
-- pudesse gravar — hoje o front tem a chave do YouTube mas não a service role.
-- Resolver isso é escolher entre dar a service role ao front ou mover a
-- resolução de vídeo do front para o backend. É decisão de arquitetura, não
-- cabia nesta migration.

create or replace function public.cache_youtube_video(p_spotify_id text, p_video_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Valida formatos: Spotify id = 22 chars base62; YouTube id = 11 chars.
  -- Em qualquer entrada inválida, no-op silencioso (não quebra a página).
  if p_spotify_id is null or p_spotify_id !~ '^[A-Za-z0-9]{22}$' then
    return;
  end if;
  if p_video_id is null or p_video_id !~ '^[A-Za-z0-9_-]{11}$' then
    return;
  end if;

  -- `do nothing`, não `do update`: preencher vazio pode, trocar o que já
  -- existe não. Quem corrige é a service role, escrevendo direto na tabela.
  insert into public.youtube_cache (spotify_track_id, youtube_video_id, updated_at)
  values (p_spotify_id, p_video_id, now())
  on conflict (spotify_track_id) do nothing;
end;
$$;

-- `set search_path = public` acima também resolve o aviso
-- function_search_path_mutable do linter para esta função.

grant execute on function public.cache_youtube_video(text, text) to anon, authenticated;
