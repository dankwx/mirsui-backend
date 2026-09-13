# Medição por álbum — 13/09/2026

O Observatório passa a consultar uma vez cada álbum com pelo menos duas faixas
na fila de medição. Cada faixa mantém seu próprio rank, associado pelo ID
Deezer. Músicas extras da resposta não entram no catálogo por esta etapa.

Faixa sem álbum ou única na fila para aquele álbum segue diretamente por
`/track/{id}`. Falha de álbum, faixa ausente ou rank inválido também passam por
esse fallback. Somente o endpoint individual pode confirmar remoção. Rank zero
é uma medição válida. Respostas paginadas são lidas até o fim; paginação inválida
ou incompleta é falha, nunca confirmação de ausência.

O agrupamento acontece antes dos blocos de execução, evitando consultar o mesmo
álbum de novo quando suas faixas atravessam páginas da fila. A admissão continua
obedecendo à cadência, prioridade e orçamento existentes. O grupo ocupa a posição
da primeira faixa na fila; as demais faixas desse álbum podem ser medidas antes
de faixas intermediárias. O orçamento continua sendo um limite de **faixas**, não
um contador global de chamadas HTTP. A cadência e os horários dos jobs não mudam.

## Banco

A migration `20260913160700_preservar_album_e_recuperar_associacoes.sql` corrige
`record_observations`: o campo `deezer_album_id` era enviado pelo backend e
descartado pelo RPC. Agora ele é persistido no INSERT e no UPDATE. Valor ausente
ou vazio não apaga o existente; uma consulta individual pode corrigir associação
antiga. O RPC continua restrito à service_role, com security invoker e search_path
fixo, preservando histórico por delta e origem da faixa.

A recuperação preenche somente associações vazias cuja origem tem formato
estrito `album:ID`. Usa `source_list` apenas quando `origin_list` é nulo. Não
altera rank, datas de medição, histórico ou associações já preenchidas. É
idempotente e não consulta o Deezer.

Aplicar atomicamente com `psql -v ON_ERROR_STOP=1 --single-transaction -f` no
banco apropriado, antes de reiniciar o backend. O nome foi gerado pelo CLI do
Supabase e o arquivo fica na pasta `migrations/`, como as migrações deste projeto.

## Observabilidade

- `medidasIndividuais`: nome legado, continua sendo o total de faixas da etapa 3.
- `medidasPorAlbum`: faixas medidas nas respostas de álbum.
- `medidasPorFaixa`: faixas medidas no endpoint individual.
- `medicaoAlbunsConsultados`: álbuns consultados, não páginas nem retentativas.

Logo, `medidasIndividuais = medidasPorAlbum + medidasPorFaixa`. Os contadores
globais do cliente Deezer continuam registrando respostas e falhas. A economia
real depende de quantas faixas vencidas compartilham álbuns, paginação e fallback.

## Validação

- `npm run typecheck` e `npm test`: 48 testes passaram.
- `psql -v ON_ERROR_STOP=1 -f src/jobs/catalogAlbum.sql.test.sql`: testa a migration
  real duas vezes, INSERT/UPDATE via service_role, preservação de metadados,
  recuperação estrita e permissões. Toda a transação termina em ROLLBACK.
- Amostra real da VPS: 10 faixas de dois álbuns medidas em duas chamadas;
  dois ranks conferidos com `/track/{id}` coincidiram. Sem gravação dessa amostra.

Os testes de TypeScript usam mocks; a amostra real é pequena e não constitui
teste de carga ou garantia de capacidade do Deezer. Esta mudança não unifica
limites entre processos, não muda o ritmo configurado e não altera os Stakes.
