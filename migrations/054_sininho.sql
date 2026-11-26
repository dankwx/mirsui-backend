-- 054_sininho.sql
-- O sino do header: os mesmos avisos da 053, agora também dentro do site.
--
-- (A 049 continua reservada para a paginação por cursor da fila do banco.)
--
-- ------------------------------------------------------------
-- O QUE É
-- ------------------------------------------------------------
-- Cada linha de `notificacoes` já era um aviso de uma pessoa. O e-mail é um
-- jeito de entregá-lo; o sino é outro. Por isso o sino ignora o `status`, que
-- é só do e-mail: quem desligou o aviso por e-mail, ou não confirmou o
-- endereço, continua vendo o aviso no site.
--
-- O que o sino NÃO mostra: aviso de seguidor de quem já deixou de seguir.
--
-- `lida_em` marca o que a pessoa já viu. Abrir o sino marca tudo como lido,
-- como no Instagram e no Letterboxd. O número do sino para em 100: acima disso
-- o header mostra "99+", e contar o resto seria trabalho à toa.
--
-- ------------------------------------------------------------
-- QUEM PODE O QUÊ
-- ------------------------------------------------------------
-- A tabela continua fechada. As três funções são `security definer` e só
-- enxergam `auth.uid()`; só `authenticated` executa.

alter table public.notificacoes
  add column if not exists lida_em timestamptz;

create index if not exists notificacoes_nao_lidas_idx
  on public.notificacoes (user_id) where lida_em is null;

create or replace function public.minhas_notificacoes(p_limite integer default 20)
returns table (
  id             bigint,
  tipo           text,
  dados          jsonb,
  criada_em      timestamptz,
  lida           boolean,
  ator_username  text,
  ator_nome      text,
  ator_avatar    text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    n.id, n.tipo, n.dados, n.criada_em, n.lida_em is not null,
    a.username::text, a.display_name::text, a.avatar_url::text
  from public.notificacoes n
  left join public.profiles a on a.id = n.ator_id
  where n.user_id = auth.uid()
    and (n.tipo <> 'seguidor' or exists (
          select 1 from public.followers f
           where f.follower_id = n.ator_id and f.following_id = n.user_id))
  order by n.criada_em desc
  limit least(greatest(coalesce(p_limite, 20), 1), 50)
$$;

create or replace function public.contar_notificacoes_nao_lidas()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
    from (
      select 1
        from public.notificacoes n
       where n.user_id = auth.uid()
         and n.lida_em is null
         and (n.tipo <> 'seguidor' or exists (
               select 1 from public.followers f
                where f.follower_id = n.ator_id and f.following_id = n.user_id))
       limit 100
    ) t
$$;

create or replace function public.marcar_notificacoes_lidas()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  update public.notificacoes
     set lida_em = now()
   where user_id = auth.uid()
     and lida_em is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.minhas_notificacoes(integer) from public, anon, authenticated;
revoke all on function public.contar_notificacoes_nao_lidas() from public, anon, authenticated;
revoke all on function public.marcar_notificacoes_lidas() from public, anon, authenticated;
grant execute on function public.minhas_notificacoes(integer) to authenticated;
grant execute on function public.contar_notificacoes_nao_lidas() to authenticated;
grant execute on function public.marcar_notificacoes_lidas() to authenticated;
