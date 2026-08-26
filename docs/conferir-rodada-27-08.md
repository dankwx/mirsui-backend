# Conferir a rodada de 27/08/2026

Escrito em 26/08/2026, depois da migration 031 e das correções de paginação.
Serve para uma coisa só: **saber se a etapa 3 voltou a medir o catálogo inteiro**,
sem precisar reconstruir o raciocínio de novo.

Rode isto depois das **05:40 BRT de 27/08** (a rodada começa 05:00 e deve levar
~35 min). Contexto completo: a revisão de 26/08 parte 2 em
[`analise-escala-apis-e-banco.md`](analise-escala-apis-e-banco.md).

---

## O estado de partida, para comparar

Medido em 26/08/2026, **antes** de qualquer correção:

| | |
|---|---|
| faixas ativas | 15.635 |
| medidas na rodada de 26/08 | 4.909 — das quais só **997** eram medição de verdade |
| há mais de 3 dias sem medição | 6.285 |
| medição mais antiga do catálogo ativo | 19/08 — 7 dias |
| duração da rodada | 4 min 11 s |

As 4.909 se decompunham em 2.476 (chart) + 997 (etapa 3) + 372 (ISRC) + 1.064
(faixas novas, que nascem com `last_checked_at` e por isso pareciam medidas).

---

## 1. O log da rodada

Procure a linha `Observatório: medições individuais concluídas`.

```
orcamento    40000
filaVencida  ~13.100    <- já SEM as do chart: a etapa 1 mede ~2.470 antes e elas saem da fila sozinhas
filaLida     = filaVencida
medidas      ~13.100    <- era 997
adiadas      < ~100     <- era ~2.571 relatado, 13.574 real
filaPorBanda { quente: ~13.100 }
```

**A regra que decide tudo: `filaLida` tem que ser exatamente
`min(filaVencida, orcamento)`.** Se for menor, alguma camada cortou no caminho —
e agora existe um `log.warn` gritando isso:

```
Observatório: fila truncada na leitura — veio menos que a fila vencida e que o orçamento
```

Se esse warn aparecer, **não suba o orçamento**: foi exatamente esse o erro de
leitura que custou uma semana. O orçamento não é o que corta.

Duas outras linhas valem o olho:

- `Observatório: orçamento esgotado, fila sobrou para amanhã` — só deve aparecer
  se `adiadas > 0`. Com 40.000 contra ~13.100, não deve aparecer.
- A rodada deve levar **~35 min**, não 4. A etapa 3 sozinha são ~27 min a
  8 req/s (`INTERVALO_MS = 125`). Se voltar a durar 4 minutos, ela mediu pouco.

---

## 2. O banco

### 2.1 A fila drenou?

```sql
select
  count(*) filter (where active)                                   as ativas,
  count(*) filter (where active and last_checked_at > now() - interval '24 hours') as medidas_24h,
  count(*) filter (where active and (last_checked_at < now() - interval '3 days'
                                     or last_checked_at is null))  as atrasadas_3d,
  min(last_checked_at) filter (where active)                       as mais_antiga
from observed_tracks;
```

| campo | 26/08 (quebrado) | 27/08 (esperado) |
|---|---|---|
| `ativas` | 15.635 | ~16.700 (+ a descoberta da noite) |
| `medidas_24h` | 4.909 | **≈ `ativas`** — é este o número que importa |
| `atrasadas_3d` | 6.285 | **0**, ou perto disso |
| `mais_antiga` | 19/08 | **27/08** |

`atrasadas_3d` caindo para zero é a prova de que a fila drenou. Se ele ainda
estiver na casa dos milhares, a etapa 3 continua cortada em algum lugar.

### 2.2 A rodada foi longa mesmo?

```sql
select
  to_char(min(last_checked_at at time zone 'America/Sao_Paulo'), 'HH24:MI:SS') as inicio,
  to_char(max(last_checked_at at time zone 'America/Sao_Paulo'), 'HH24:MI:SS') as fim,
  round(extract(epoch from (max(last_checked_at) - min(last_checked_at)))/60) as minutos,
  count(*) as faixas
from observed_tracks
where active and last_checked_at >= current_date;
```

Esperado: início 05:00, fim por volta de **05:35**, ~35 min, ~16.700 faixas.
Em 26/08 isso deu 4 minutos e 4.909 — se repetir, nada mudou.

### 2.3 A decomposição, se algo parecer errado

Cada `last_checked_at` distinto é uma escrita em lote. Isto separa o que é
medição do que é faixa nova entrando:

```sql
select
  to_char(last_checked_at at time zone 'America/Sao_Paulo','HH24:MI:SS') as lote,
  count(*) as faixas,
  count(*) filter (where added_at >= current_date) as sao_novas
from observed_tracks
where active and last_checked_at >= current_date
group by 1 order by 1;
```

A coluna `sao_novas` é a armadilha de 26/08: 1.064 das 4.909 eram inserções da
descoberta, não medições. Desconte-as antes de comemorar qualquer número.

### 2.4 O corte do PostgREST, direto

Se houver qualquer dúvida, esta é a medição que não admite interpretação — a
mesma consulta pelos dois caminhos:

```sql
select
  (select count(*) from observatory_measurement_queue(40000)) as pelo_sql,
  (select observatory_queue_size())                            as fila_vencida;
```

E pelo caminho do job (PostgREST), com a service role key:

```bash
curl -s -X POST "$SUPABASE_URL/rest/v1/rpc/observatory_measurement_queue" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Range-Unit: items" -H "Range: 0-999" \
  -d '{"p_limite": 40000}' | jq 'length'
```

Devolve 1.000 por página — **isso está certo**, é a página. O errado seria o job
parar na primeira. `Range-Unit: items` é obrigatório; sem ele o PostgREST ignora
o `Range` e devolve tudo (foi o que me enganou na primeira tentativa).

---

## 3. Verde, em uma linha

> `filaLida == filaVencida`, `atrasadas_3d ≈ 0`, `mais_antiga` = hoje, rodada de
> ~35 min.

## 4. Se estiver errado

| sintoma | leitura |
|---|---|
| `filaLida < filaVencida` e o warn apareceu | outra camada cortando. **Não é o orçamento.** Comparar os dois caminhos da 2.4 |
| `filaLida == filaVencida` mas `medidas` bem menor | o Deezer não respondeu — olhar `falhas` e `code: 4` (quota) em `deezerCatalog.ts` |
| `adiadas` alto com `filaLida` correto | aí sim o orçamento é pequeno. Subir `OBS_ORCAMENTO_MEDICAO` ou esfriar as bandas |
| rodada de 4 min de novo | o deploy não pegou. `pm2 restart` e conferir que o código no servidor tem `filaLida` |

---

## 5. Pendências que não são desta rodada

- **Devolver `db-max-rows` para 1.000** no painel do Supabase. Com a paginação de
  volta, o teto só precisa ser ≥ o tamanho da página (1.000). Os 20.000 foram o
  analgésico de 26/08; deixar assim é superfície aberta sem motivo.
- **Rotar a service role key e o `SPOTIFY_CLIENT_SECRET`** — circularam em texto
  em 26/08.
- **11/11/2026** é o próximo prazo: a 1.100 faixas/dia o catálogo bate na
  `OBS_MAX_CATALOGO = 100.000` e o custo diário chega a ~38.700 requisições
  (~81 min), logo abaixo dos 40.000 do orçamento. Cada +1.000 em
  `OBS_LIMITE_DESCOBERTA` são +30.000 de banda quente permanente.
