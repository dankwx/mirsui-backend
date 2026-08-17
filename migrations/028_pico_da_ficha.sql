-- 028_pico_da_ficha.sql
-- Duas correções na pontuação de Stakes, as duas medidas nos dados reais de
-- 23/06 a 16/08/2026 (42 dias, 3 fichas, 126 snapshots).
--
-- ------------------------------------------------------------
-- 1. O PROBLEMA: o ganho era medido contra a ÚLTIMA medição
-- ------------------------------------------------------------
-- `computePointsGain(last_popularity, hoje, mult)` paga toda subida diária e
-- ignora toda queda. O acumulado não é "o quanto a faixa subiu" — é a soma de
-- TODAS as subidas, ou seja, a variação total pra cima. Uma faixa que oscila
-- paga a mesma subida de novo a cada ciclo.
--
-- Não é teórico. Estado das três fichas quando esta migration foi escrita:
--
--   faixa                       base  pico  agora  pts hoje  pts pelo pico
--   Ginseng Strip 2002 (x1,78)    70    70     70         5              0
--   eyes (x2,92)                  36    36     17        44              0
--   Leviathan (x2,72)             19    26      7        54             19
--
-- "eyes" nunca passou do ponto onde a ficha foi botada, está hoje em menos da
-- metade dele, e tem 44 pontos. "Ginseng" nunca subiu um ponto sequer em 41
-- medições e tem 5. Dos 103 pontos existentes, 84 são ruído de oscilação — e a
-- ficha mais bem paga (54) é a que mais caiu (19 -> 7). O jogo diz que premia
-- quem acha a faixa que vai bombar; o que ele paga é tremor de rank.
--
-- A REGRA NOVA: marca d'água. O ganho é medido contra o MAIOR popScore que a
-- faixa já atingiu desde a ficha, nunca contra a medição de ontem:
--
--   ganho = max(0, popScore_hoje - peak_popularity)
--   peak_popularity = max(peak_popularity, popScore_hoje)
--
-- Consequências:
--   * recuperar terreno perdido não paga de novo — só bater o próprio recorde;
--   * o acumulado passa a ser exatamente (pico - base) * multiplicador;
--   * "você nunca perde ponto" vira literalmente verdade, e não uma meia-verdade
--     que o card contradizia em laranja.
--
-- SEM RETROATIVO. `accumulated_points` fica como está: os 103 pontos foram
-- ganhos sob a regra antiga e tirá-los seria confiscar saldo. O que a migration
-- faz é fixar `peak_popularity` no pico REAL já observado (não no valor de
-- hoje), pra ninguém sair daqui com uma régua rebaixada e reganhar de graça o
-- caminho que já pagou. Na prática as três fichas param de acumular até
-- superarem o próprio recorde — que é o comportamento correto.

alter table public.stakes
  add column if not exists peak_popularity integer;

-- O pico verdadeiro é o maior entre: onde a ficha foi botada, a última medição,
-- e o máximo já registrado nos snapshots. Os três porque nenhum sozinho basta:
-- baseline ignora o que veio depois, last_popularity é só o de hoje (a ficha
-- pode ter caído do pico), e os snapshots podem ter buracos — o job ficou fora
-- do ar de 25/07 a 08/08 e não mediu nada nesses 14 dias.
update public.stakes s
   set peak_popularity = greatest(
         coalesce(s.baseline_popularity, 0),
         coalesce(s.last_popularity, 0),
         coalesce((select max(sn.popularity)
                     from public.stake_snapshots sn
                    where sn.stake_id = s.id), 0)
       )
 where s.peak_popularity is null;

alter table public.stakes
  alter column peak_popularity set default 0,
  alter column peak_popularity set not null;

comment on column public.stakes.peak_popularity is
  'Maior popScore (0-100) ja atingido desde a ficha. O ganho diario e medido contra ele, nao contra a ultima medicao: recuperar queda nao paga de novo.';

-- ------------------------------------------------------------
-- 2. O PROBLEMA: `removida` confiscava o acumulado
-- ------------------------------------------------------------
-- Quando o Deezer devolve 800 (DataNotFound) o job marca `status='removida'`.
-- Aí o único botão do card chamava esta mesma função, que caía no else e
-- APAGAVA a linha com 0 ponto — mesmo com 300 pontos acumulados em 20 dias.
--
-- E "removida" não quer dizer que a faixa saiu do mundo: quer dizer que aquele
-- `deezer_track_id` parou de resolver. Acontece com re-upload, troca de
-- distribuidora, mudança de licenciamento por região. Do lado do usuário: ele
-- abre o Spotify, a faixa toca normalmente, e o app diz que ela não vale mais e
-- come o que ele juntou. É a pior coisa que este produto faz hoje.
--
-- A REGRA NOVA: parar de medir não é perder o que já foi medido. Se a ficha já
-- cumpriu os 7 dias e tem saldo, ela é coletável mesmo em 'removida'. O que se
-- perde é o futuro (não acumula mais), não o passado.
--
-- O resto da semântica não muda:
--   * < 7 dias, ou saldo 0  -> apaga a linha, 0 ponto (o "esvaziar vaga")
--   * 'coletada'            -> não entra em nenhum ramo de coleta de novo
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

  if v_stake.status in ('ativa', 'removida')
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

-- Conferir o estado final:
--
--   select track_title, baseline_popularity, peak_popularity, last_popularity,
--          accumulated_points, status
--   from public.stakes order by staked_at;
--
-- Esperado: peak >= greatest(baseline, last) em toda linha.
