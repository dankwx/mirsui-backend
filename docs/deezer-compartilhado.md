# Deezer compartilhado — 13/09/2026

O backend, os jobs, scripts do catálogo e o frontend Next usam o mesmo serviço
`mirsui-deezer-gateway`, escutando apenas em `127.0.0.1:3012`. O único fetch
externo ao Deezer está em `src/lib/deezerGateway.ts`. Não há fallback que acesse
a API diretamente quando o gateway está indisponível.

## Comportamento

- Padrão de 3 partidas por segundo (intervalo de 334 ms), com até 4 em voo.
  É uma configuração conservadora, não garantia de capacidade do fornecedor.
- Rodízio ponderado de chamadas interativas, Stakes e catálogo (4:2:1 quando
  todas as filas têm demanda). Usuários não ficam atrás da fila inteira do job;
  o catálogo também recebe oportunidades sob tráfego interativo contínuo.
- Requisições simultâneas ao mesmo caminho normalizado compartilham uma resposta.
  Busca e paginação têm parâmetros normalizados para melhorar a deduplicação.
- Cache compartilhado de respostas bem-sucedidas: janela solicitada pelo cliente,
  limitada a 15 minutos para faixa/busca e 24 horas para os demais recursos.
  O frontend conserva suas janelas de 15 min / 5 min / 24 h. Limites de memória:
  2.000 entradas, 32 MB no total, 2 MB por entrada. Erros não são cacheados.
- Medições de catálogo e Stakes exigem resposta fresca (`maxAgeMs=0`); podem
  compartilhar uma chamada já em voo, mas não recebem medições antigas do cache.
  Criação/prévia de Stakes também exige dados frescos para preservar a base e o
  multiplicador. Consultas interativas de metadados podem aproveitar o cache.
- HTTP 403, 429 e erro Deezer 4 em HTTP 200 pausam globalmente novas partidas.
  A pausa cresce de 30 s até 300 s, respeitando Retry-After quando maior (teto
  de uma hora). Chamadas já em voo podem terminar; uma resposta anterior ao
  bloqueio não libera a fila. Após a pausa, somente uma sondagem fica em voo.
- A pausa é persistida em arquivo privado para sobreviver a reinícios. Não
  persiste o cache de metadados. O gateway tem uma única instância PM2; iniciar
  outra instância na mesma porta falha, evitando múltiplos limitadores ativos.
- Timeout de 10 s na API externa; clientes interativos esperam até 8 s no serviço,
  jobs até 120 s. Fila limitada a 1.000 recursos distintos. Catálogo repete até
  oito vezes as pausas e indisponibilidades transitórias indicadas pelo gateway.

## Stakes

Dentro de cada execução do job, `sharedStakeRank` guarda a promessa de leitura
por ID Deezer. Mil fichas da mesma faixa usam uma consulta e o mesmo rank.
Músicas diferentes permanecem independentes. Falhas transitórias também são
compartilhadas nessa execução, sem virar zero nem remoção. Na próxima execução
podem ser consultadas novamente.

Horário das 09:00, normalização, multiplicador, cálculo por pico e persistência
da pontuação permanecem os existentes. A observação das 05:00 do Observatório
não substitui a medição dos Stakes. O compartilhamento é por execução, não uma
nova tabela de apuração diária persistente; reiniciar manualmente o job pode
consultar novamente as músicas de fichas ainda não processadas.

## Configuração e deploy

No `.env` do backend e `.env.production` do frontend, definir o mesmo
`DEEZER_GATEWAY_TOKEN` privado (gerar aleatoriamente ao menos 32 caracteres) e
`DEEZER_GATEWAY_URL=http://127.0.0.1:3012`. Nunca prefixar o token com NEXT_PUBLIC.
Somente o servidor do gateway também recebe:

```
DEEZER_REQUESTS_PER_SECOND=3
DEEZER_GATEWAY_STATE_FILE=/home/ubuntu/.local/state/mirsui/deezer-gateway.json
```

Subir com `pm2 start ops/deezer-gateway.config.cjs` no backend. Confirmar
`curl http://127.0.0.1:3012/health`, reiniciar backend, compilar e implantar
frontend incluindo a cópia do `.env.production` para o standalone, e salvar a
lista com `pm2 save`. Alterações de taxa exigem reiniciar o gateway. A porta não
deve ser publicada pelo nginx. Scripts locais também precisam desse gateway.

Rollback: reverter os commits dos clientes em ambos os projetos e reimplantar
antes de desligar o serviço. Não apagar a pausa persistida para contornar um
bloqueio. As configurações anteriores de ambiente foram copiadas para backups
privados em `mirsui-dump`; nenhuma credencial é versionada.

## Verificação

61 testes e typecheck do backend passaram, incluindo mil fichas/uma leitura,
frescor, deduplicação, concorrência, prioridade, HTTP 403/429, erro 4, timeout,
fila cheia, paginação e recuperação por álbum. Build e typecheck do frontend
passaram; o build emitiu avisos já existentes fora desta alteração.

Teste real do gateway: 20 pedidos concorrentes, uma chamada ao Deezer e 19
respostas compartilhadas. Pedido sem token recebeu 401. Catálogo e leitor de
Stakes foram exercitados sem gravar pontos: álbum retornou 14 faixas e a faixa
individual retornou rank válido. Página pública de artista servida pelo Next:
primeira visita fez três consultas; a segunda fez zero chamadas externas.
Busca anônima exige sessão no middleware existente, então a validação do
frontend usou a página pública de artista.

`/health` e o log por minuto do gateway mostram chamadas externas, acertos de
cache, compartilhamentos em voo, pausas, falhas e distribuição por prioridade.
O log dos Stakes inclui `uniqueTracks` e `sharedReads`. Os contadores antigos
do catálogo são por cliente: `bloqueios` conta esperas individuais e
`esperaBloqueioMs` soma esperas concorrentes; ondas e taxa globais devem ser
lidas no gateway. Esses testes não são uma medição sustentada de capacidade.
