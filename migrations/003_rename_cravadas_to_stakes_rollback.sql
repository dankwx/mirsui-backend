-- 003_rename_cravadas_to_stakes_rollback.sql
-- Reverte 003: stakes -> cravadas. Use só se precisar voltar o banco ao estado
-- anterior (ex.: rollback do deploy do backend/frontend).

begin;

-- função
drop function if exists public.count_stakes_by_track_uri(text[]);

create or replace function public.count_cravadas_by_track_uri(p_uris text[])
 returns table(track_uri text, total bigint)
 language sql
 security definer
 set search_path to 'public'
as $function$
  select c.track_uri, count(*)::bigint as total
  from public.cravadas c
  where c.status = 'ativa' and c.track_uri = any(p_uris)
  group by c.track_uri;
$function$;

-- policies
alter policy stakes_select_own            on public.stakes            rename to cravadas_select_own;
alter policy stakes_insert_own            on public.stakes            rename to cravadas_insert_own;
alter policy stakes_update_own            on public.stakes            rename to cravadas_update_own;
alter policy stakes_delete_own            on public.stakes            rename to cravadas_delete_own;
alter policy stake_snapshots_select_own   on public.stake_snapshots   rename to cravada_snapshots_select_own;
alter policy stake_collections_select_own on public.stake_collections rename to cravada_collections_select_own;
alter policy stake_collections_insert_own on public.stake_collections rename to cravada_collections_insert_own;

-- índices secundários
alter index public.stakes_track_uri_idx       rename to cravadas_track_uri_idx;
alter index public.stakes_user_status_idx     rename to cravadas_user_status_idx;
alter index public.stake_snapshots_stake_idx  rename to cravada_snapshots_cravada_idx;
alter index public.stake_collections_user_idx rename to cravada_collections_user_idx;

-- constraints
alter table public.stakes            rename constraint stakes_pkey                      to cravadas_pkey;
alter table public.stakes            rename constraint stakes_user_id_fkey              to cravadas_user_id_fkey;
alter table public.stakes            rename constraint stakes_status_check              to cravadas_status_check;
alter table public.stake_snapshots   rename constraint stake_snapshots_pkey            to cravada_snapshots_pkey;
alter table public.stake_snapshots   rename constraint stake_snapshots_stake_id_fkey   to cravada_snapshots_cravada_id_fkey;
alter table public.stake_collections rename constraint stake_collections_pkey          to cravada_collections_pkey;
alter table public.stake_collections rename constraint stake_collections_user_id_fkey  to cravada_collections_user_id_fkey;

-- sequences
alter sequence public.stake_snapshots_id_seq   rename to cravada_snapshots_id_seq;
alter sequence public.stake_collections_id_seq rename to cravada_collections_id_seq;

-- colunas
alter table public.stakes            rename column staked_at to craved_at;
alter table public.stake_snapshots   rename column stake_id  to cravada_id;
alter table public.stake_collections rename column stake_id  to cravada_id;

-- tabelas
alter table public.stakes            rename to cravadas;
alter table public.stake_snapshots   rename to cravada_snapshots;
alter table public.stake_collections rename to cravada_collections;

commit;
