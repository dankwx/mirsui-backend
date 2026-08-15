-- 022_compactar_historico.sql
-- Aplica retroativamente a regra da 021 ao que já estava gravado.
-- APLICADA EM PRODUÇÃO em 15/08/2026.
--
-- SEPARADA DA 021 DE PROPÓSITO
-- A 021 muda a regra de escrita e não depende desta: a partir dela, nenhuma
-- linha redundante nova entra. Esta mexe em dado que já existe, e isso é uma
-- decisão de outra natureza — merece ser lida e aprovada em separado.
--
-- O QUE SAIU
-- Toda linha cujo rank era igual ao da linha anterior da mesma faixa — exatamente
-- o que a regra da 021 teria descartado na hora da escrita. A primeira linha de
-- cada faixa nunca foi candidata: `lag` devolve NULL e o filtro exige igualdade,
-- e NULL nunca casa.
--
-- Só mexeu em source='deezer'. As 37 linhas legadas de 'spotify:track:'
-- ('migration' e 'user_claim', a última de 12/06/2026) ficaram intactas.
--
-- VERIFICAÇÃO
-- Antes: reconstruindo a série densa a partir do delta, zero divergências.
-- Depois: reconstruindo a série densa a partir da tabela JÁ COMPACTADA e
-- comparando com o backup, dia a dia:
--
--   dias_conferidos    20.990
--   faixas_conferidas   6.490
--   divergências            0
--
-- E os hashes de get_track_curve e get_landing_observatory continuaram batendo
-- byte a byte com os de antes da 021 — o site não viu diferença nenhuma.
--
-- RESULTADO (com reindex + vacuum full)
--
--            linhas    total     dados    índices   B/linha
--   antes    21.027   5.632 kB  1.744 kB  3.848 kB    274
--   depois    7.707   1.528 kB    640 kB    880 kB    203
--                     -72,9%
--
-- BACKUP
-- public.track_popularity_history_bkp_20260815 — cópia integral das 21.027
-- linhas, tirada imediatamente antes. Some quando não fizer mais falta:
--
--   drop table public.track_popularity_history_bkp_20260815;

with ordenada as (
  select id, rank,
         lag(rank) over (partition by track_uri order by recorded_at, id) as anterior
  from public.track_popularity_history
  where source = 'deezer' and rank is not null
)
delete from public.track_popularity_history h
using ordenada o
where h.id = o.id
  and o.anterior is not null
  and o.rank = o.anterior;

-- Rodados fora da transação, nesta ordem. O delete sozinho libera espaço para
-- reuso mas não devolve disco: sem o vacuum full o heap fica em 1.744 kB com
-- 45% de espaço morto, que só seria reabsorvido pelas inserções das próximas
-- noites. Numa tabela deste tamanho o lock exclusivo dura milissegundos.
--
--   reindex table concurrently public.track_popularity_history;
--   vacuum (analyze) public.track_popularity_history;
--   vacuum full public.track_popularity_history;
