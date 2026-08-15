-- 018_ledger_de_stakes_fechado.sql
-- Tira do cliente o poder de escrever no ledger dos Stakes.
--
-- O PROBLEMA
-- As três tabelas do sistema (`stakes`, `stake_snapshots`, `stake_collections`)
-- estavam com os grants padrão do Supabase — INSERT/UPDATE/DELETE em TODAS as
-- colunas, para `anon` e `authenticated` — e as policies só perguntavam
-- `auth.uid() = user_id`. Ou seja: cada um mandava na própria linha, incluindo
-- nas colunas que valem ponto. Com a anon key (que está no bundle JS) e um
-- login qualquer:
--
--   POST /rest/v1/stake_collections
--   { "user_id": "<o meu próprio>", "points": 999999999 }
--
-- `GET /stakes/points` é um `sum(points)` dessa tabela, então o total do
-- usuário era, na prática, um campo de texto livre. Pelo mesmo caminho dava
-- para dar PATCH em `stakes`:
--
--   * `accumulated_points` — o número que a coleta transforma em ponto;
--   * `multiplier` — travado no dia do stake, medido no Deezer;
--   * `staked_at` — backdatar fura a regra dos 7 dias de recolher;
--   * `status` — voltar de 'coletada' para 'ativa' e coletar o mesmo saldo de novo.
--
-- E `stake_snapshots`, que é o histórico que sustenta o gráfico e explica de
-- onde veio cada ponto, também era escrita livre — dava para inventar a curva.
--
-- A policy estava certa para a pergunta "de quem é esta linha?". A pergunta que
-- ninguém fazia era "quem tem direito de escrever ESTE número aqui?". Dono da
-- linha não é o mesmo que autor do valor: o valor vem do Deezer, medido pelo
-- servidor, e o usuário nunca deveria ter sido a fonte dele.
--
-- Auditoria antes desta migration: 3 stakes, 120 snapshots, 0 coletas.
-- `max(accumulated_points) = 54`, `max(multiplier) = 2.92` — tudo dentro do que
-- o job diário produz. O buraco estava aberto e não foi usado.
--
-- O QUE MUDA
-- Escrita nas três tabelas sai de `anon` e `authenticated`. Sobra o SELECT, que
-- as policies existentes já limitam às linhas do próprio usuário. Ficam
-- exatamente dois caminhos de escrita, os dois do lado do servidor:
--
--   1. a service role, no backend — POST /stakes (valores medidos no Deezer na
--      hora do stake) e o job diário de snapshot, que já rodava assim;
--   2. `collect_stake()`, criada aqui: SECURITY DEFINER, com a regra dos 7 dias
--      dentro do banco.
--
-- POR QUE UMA FUNÇÃO PARA RECOLHER, E NÃO SÓ MAIS SERVICE ROLE
-- Recolher é ler-decidir-escrever em duas tabelas. Do lado do Node isso são
-- roundtrips soltos, sem transação: dois "recolher" simultâneos no mesmo stake
-- passavam os dois pela checagem e gravavam DOIS lançamentos do mesmo saldo.
-- Esse bug existe hoje e não depende de anon key nenhuma — dois cliques rápidos
-- bastam. Dentro da função é uma transação só, com `for update` na linha do
-- stake: o segundo pedido espera o primeiro e já encontra `status <> 'ativa'`.
-- De quebra, a regra dos 7 dias passa a morar junto do dado em vez de existir
-- só como um `if` no Node.
--
-- O QUE SOBRA
-- O limite de 3 vagas continua checado só no Node (contar e depois inserir, sem
-- lock), então POSTs simultâneos ainda conseguem abrir uma vaga a mais. O índice
-- único parcial abaixo fecha o caso gêmeo — dois stakes ativos na mesma faixa —
-- que é o que dá ponto em dobro. O limite de contagem exigiria trigger e não
-- cabia nesta migration.

-- ------------------------------------------------------------
-- 1. Escrita sai do cliente
-- ------------------------------------------------------------
-- As policies de escrita vão embora junto: sem grant elas já não pegavam, mas
-- deixá-las no banco sugeriria que este caminho ainda existe.
drop policy if exists "stakes_insert_own"            on public.stakes;
drop policy if exists "stakes_update_own"            on public.stakes;
drop policy if exists "stakes_delete_own"            on public.stakes;
drop policy if exists "stake_collections_insert_own" on public.stake_collections;

revoke insert, update, delete, truncate, references on public.stakes            from anon, authenticated;
revoke insert, update, delete, truncate, references on public.stake_collections from anon, authenticated;
revoke insert, update, delete, truncate, references on public.stake_snapshots   from anon, authenticated;

-- O que continua: SELECT nas três, filtrado pelas policies que já existiam
-- (stakes_select_own, stake_collections_select_own, stake_snapshots_select_own).
-- `service_role` tem bypassrls e mantém os grants — o backend não é afetado.

-- ------------------------------------------------------------
-- 2. Recolher vira função, com a regra dentro do banco
-- ------------------------------------------------------------
-- Mesma semântica da rota POST /stakes/:id/recolher de antes:
--   * >= 7 dias, ainda 'ativa' e com saldo  -> grava no ledger e marca 'coletada'
--   * qualquer outro caso                   -> apaga a linha, 0 ponto
--     (é o "esvaziar vaga": desistir antes dos 7 dias, ou faixa que saiu do
--      Deezer e virou 'removida')
-- `found = false` quer dizer "não é seu ou não existe" — a rota devolve 404.
create or replace function public.collect_stake(p_stake_id uuid)
returns table (found boolean, collected boolean, points integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stake public.stakes%rowtype;
begin
  -- `user_id = auth.uid()` é a autorização: com token de outro usuário (ou sem
  -- token, quando auth.uid() é null) não casa linha nenhuma.
  -- `for update` segura a linha até o fim da transação.
  select * into v_stake
  from public.stakes
  where id = p_stake_id and user_id = auth.uid()
  for update;

  if not found then
    return query select false, false, 0;
    return;
  end if;

  if v_stake.status = 'ativa'
     and now() - v_stake.staked_at >= interval '7 days'
     and v_stake.accumulated_points > 0
  then
    insert into public.stake_collections (user_id, stake_id, track_title, artist_name, points)
    values (
      v_stake.user_id,
      v_stake.id,
      v_stake.track_title,
      v_stake.artist_name,
      v_stake.accumulated_points
    );

    update public.stakes
       set status = 'coletada', collected_at = now()
     where id = v_stake.id;

    return query select true, true, v_stake.accumulated_points;
  else
    -- stake_snapshots cai junto (FK on delete cascade); o ledger não, porque
    -- stake_collections.stake_id não tem FK para stakes.
    delete from public.stakes where id = v_stake.id;
    return query select true, false, 0;
  end if;
end;
$$;

revoke execute on function public.collect_stake(uuid) from public, anon;
grant execute on function public.collect_stake(uuid) to authenticated;

-- ------------------------------------------------------------
-- 3. Um stake ativo por faixa, garantido pelo banco
-- ------------------------------------------------------------
-- O backend já checava isso antes de inserir, mas entre a checagem e o insert
-- cabe outro insert. Conferido antes de criar: nenhuma duplicata existente.
create unique index if not exists stakes_um_ativo_por_faixa
  on public.stakes (user_id, track_uri)
  where status = 'ativa';

-- Conferir o estado final:
--
--   select grantee, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('stakes', 'stake_collections', 'stake_snapshots')
--     and grantee in ('anon', 'authenticated');
--
-- Esperado: só SELECT.
