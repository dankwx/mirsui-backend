-- 003_rename_cravadas_to_stakes.sql
-- Renomeia a feature "cravadas" para "stakes" no banco: tabelas, colunas,
-- sequences, constraints, índices, policies e a função de contagem social.
-- Renomes puros de metadados (transacional). Os dados são preservados.
--
-- ATENÇÃO: o backend e o frontend precisam ser deployados juntos com esta
-- migration — o código antigo consulta 'cravadas' e quebra após o rename.

begin;

-- tabelas
alter table public.cravadas            rename to stakes;
alter table public.cravada_snapshots   rename to stake_snapshots;
alter table public.cravada_collections rename to stake_collections;

-- colunas
alter table public.stakes            rename column craved_at  to staked_at;
alter table public.stake_snapshots   rename column cravada_id to stake_id;
alter table public.stake_collections rename column cravada_id to stake_id;

-- sequences (a de cravadas é uuid, não tem sequence)
alter sequence public.cravada_snapshots_id_seq   rename to stake_snapshots_id_seq;
alter sequence public.cravada_collections_id_seq rename to stake_collections_id_seq;

-- constraints (renomear a PK/UNIQUE também renomeia o índice de apoio)
alter table public.stakes            rename constraint cravadas_pkey                       to stakes_pkey;
alter table public.stakes            rename constraint cravadas_user_id_fkey               to stakes_user_id_fkey;
alter table public.stakes            rename constraint cravadas_status_check               to stakes_status_check;
alter table public.stake_snapshots   rename constraint cravada_snapshots_pkey             to stake_snapshots_pkey;
alter table public.stake_snapshots   rename constraint cravada_snapshots_cravada_id_fkey  to stake_snapshots_stake_id_fkey;
alter table public.stake_collections rename constraint cravada_collections_pkey           to stake_collections_pkey;
alter table public.stake_collections rename constraint cravada_collections_user_id_fkey   to stake_collections_user_id_fkey;

-- índices secundários (os *_pkey já foram renomeados junto com as constraints)
alter index public.cravadas_track_uri_idx        rename to stakes_track_uri_idx;
alter index public.cravadas_user_status_idx      rename to stakes_user_status_idx;
alter index public.cravada_snapshots_cravada_idx rename to stake_snapshots_stake_idx;
alter index public.cravada_collections_user_idx  rename to stake_collections_user_idx;

-- policies (as expressões USING/WITH CHECK seguem os objetos por OID; só o nome muda)
alter policy cravadas_select_own            on public.stakes            rename to stakes_select_own;
alter policy cravadas_insert_own            on public.stakes            rename to stakes_insert_own;
alter policy cravadas_update_own            on public.stakes            rename to stakes_update_own;
alter policy cravadas_delete_own            on public.stakes            rename to stakes_delete_own;
alter policy cravada_snapshots_select_own   on public.stake_snapshots   rename to stake_snapshots_select_own;
alter policy cravada_collections_select_own on public.stake_collections rename to stake_collections_select_own;
alter policy cravada_collections_insert_own on public.stake_collections rename to stake_collections_insert_own;

-- função de contagem social ("X pessoas deram stake")
drop function if exists public.count_cravadas_by_track_uri(text[]);

create or replace function public.count_stakes_by_track_uri(p_uris text[])
 returns table(track_uri text, total bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select c.track_uri, count(*)::bigint as total
  from public.stakes c
  where c.status = 'ativa' and c.track_uri = any(p_uris)
  group by c.track_uri;
$function$;

commit;
