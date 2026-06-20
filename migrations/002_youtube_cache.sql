-- 002_youtube_cache.sql
-- Cache permanente de resoluções Spotify track id -> YouTube video id.
--
-- Motivo: a página de track (app/(dashboard)/track/[id]/page.tsx) buscava na
-- YouTube Data API a cada renderização. A cota gratuita é de 10k unidades/dia
-- e cada busca custa 100 unidades (~100 buscas/dia). Este cache torna cada
-- música 1 busca única para sempre, em vez de 1 por visualização/dia.
--
-- A coluna tracks.youtube_url NÃO serve para isso: a tabela tracks é de
-- reivindicações (várias linhas por música, e zero linhas para músicas nunca
-- reivindicadas), e a RLS tracks_update_own impede um visitante de gravar.
--
-- Aplicada em produção (projeto soundsage) via migration `create_youtube_cache`.

create table if not exists public.youtube_cache (
  spotify_track_id text primary key,
  youtube_video_id text not null,
  updated_at timestamptz not null default now()
);

alter table public.youtube_cache enable row level security;

-- Leitura pública: páginas de track (cliente anon) precisam ler o cache.
drop policy if exists "youtube_cache_select_public" on public.youtube_cache;
create policy "youtube_cache_select_public"
  on public.youtube_cache for select
  using (true);

-- Sem policies de INSERT/UPDATE: a escrita só acontece pela função abaixo
-- (SECURITY DEFINER), que valida o formato dos ids. A tabela fica trancada
-- contra escrita direta, mesmo por usuários autenticados.
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

  insert into public.youtube_cache (spotify_track_id, youtube_video_id, updated_at)
  values (p_spotify_id, p_video_id, now())
  on conflict (spotify_track_id)
  do update set youtube_video_id = excluded.youtube_video_id, updated_at = now();
end;
$$;

grant execute on function public.cache_youtube_video(text, text) to anon, authenticated;

-- Semeia o cache com os mapeamentos já existentes em tracks.youtube_url,
-- para não perder buscas já pagas.
insert into public.youtube_cache (spotify_track_id, youtube_video_id)
select distinct on (sid) sid, vid
from (
  select
    substring(track_uri from 'spotify:track:([A-Za-z0-9]+)') as sid,
    substring(youtube_url from 'v=([A-Za-z0-9_-]+)') as vid
  from public.tracks
  where youtube_url is not null and track_uri like 'spotify:track:%'
) m
where sid ~ '^[A-Za-z0-9]{22}$' and vid ~ '^[A-Za-z0-9_-]{11}$'
on conflict (spotify_track_id) do nothing;
