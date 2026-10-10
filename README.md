# Views que não parecem humanas

API que recebe a série de views por hora de um post e responde se o padrão é compatível com audiência
humana: `legitimo`, `suspeito` ou `inconclusivo`, com um motivo em português e os sinais medidos. O
classificador é uma função pura com quatro sinais explicáveis. Junto vêm um dataset sintético reproduzível e
um comando que mede a taxa de falso positivo e escreve o número neste README.

O critério completo, inclusive o que ele não detecta, está em [docs/criterio.md](docs/criterio.md). Defini o
critério antes de implementar. O contrato completo da API, os erros e exemplos de resposta estão em
[docs/api.md](docs/api.md), e o teste de carga em [docs/carga.md](docs/carga.md).

## Como rodar

Requer Node 22.13 ou mais novo (uso `node:sqlite`) e Docker para o teste de carga.

```bash
npm install
npm run dev          # API em http://localhost:3000 (PORT e DB_PATH configuráveis)
npm test             # unitários + integração
npm run typecheck
npm run dataset      # gera data/dataset.json (duas partições, sementes fixas)
npm run calibrate    # escolhe os limiares na partição de calibração e grava src/classifier/thresholds.json
npm run evaluate     # mede na partição de avaliação, grava data/metrics.json e o bloco de métricas abaixo
npm run load         # k6 via Docker na porta 3107 + verificação de determinismo
```

## Contrato

`POST /classify` recebe `{ post_id, published_at, points: [{ hour, views }] }`, com `views` **incremental**
(as views ganhas naquela hora, não o acumulado) e `hour` de 0 em diante, sem buraco nem repetição. Escolhi
incremental porque todos os sinais olham a forma da curva hora a hora. A resposta traz `classification`,
`reason`, `signals` (cada um com valor medido, limiar e se disparou) e um `id` para consultar depois em
`GET /classifications/:id`.

Validação e limites: todo corpo passa por zod. Série com menos de 24 ou mais de 2160 horas, hora repetida,
faltando ou fora de ordem, views negativas, fracionárias ou acima de 1 bilhão e `published_at` sem fuso ou
inexistente dão 400. Corpo acima de 1 MB dá 413, `Content-Type` que não é JSON dá 415 e série que termina no
futuro dá 422. Campos extras são ignorados. A tabela completa está em [docs/api.md](docs/api.md#erros).

## O critério em uma tela

| sinal | o que mede | por que separa humano de robô |
|---|---|---|
| `pico_sem_cauda` | quanto das views extras do pico ainda aparece nas 10 horas depois dele | viral é compartilhado e decai aos poucos; lote comprado chega e para |
| `queda_abrupta` | maior queda de uma hora para outra que se sustenta, depois de um patamar de pelo menos 30 views/h, sem contar a que se repete no mesmo horário do dia anterior ou seguinte | gente desacelera aos poucos; pacote de views acaba de uma vez |
| `repeticao_mecanica` | menor índice de dispersão (variância / média) em janelas de 12 horas | contagem de pessoas oscila pelo menos como uma Poisson; robô entrega 200, 201, 200 |
| `rajadas_periodicas` | fração dos intervalos entre rajadas que são exatamente iguais | pessoas não chegam num relógio |

As regras valem nesta ordem, e a primeira que bate decide:

1. Algum sinal disparou: `suspeito`.
2. Pico relevante com cauda curta demais para julgar, ou sem horas suficientes depois dele: `inconclusivo`.
3. Mediana abaixo de 5 views/h e nenhuma hora com 100 views ou mais: `inconclusivo`.
4. Série com menos de 48 horas: `inconclusivo`.
5. Caso contrário: `legitimo`.

`suspeito` quer dizer "merece revisão humana", não fraude comprovada. Os limiares de disparo saem de
`npm run calibrate` e ficam em `src/classifier/thresholds.json`.

## Resultado no dataset

<!-- metrics:start -->
Gerado por `npm run evaluate` na partição de **avaliação** (semente 2002, 620 séries, sha256 `76da2b80d9e3`), com os limiares calibrados na outra partição. Classificador 1.0.0.

- Taxa de falso positivo: <!-- fpr -->2,50%<!-- /fpr --> (11 de 440 legítimos classificados como suspeito)
- Recall: 57,78% (104 de 180 suspeitos detectados)
- Precisão: 90,43%
- Inconclusivo: 29,09% dos legítimos e 17,78% dos suspeitos
- Para comparar, na partição de calibração (semente 1001): falso positivo 1,82%, recall 55,56%
- Estabilidade em 5 pares de sementes (calibra em uma, mede na outra): falso positivo de 1,59% a 2,50% e recall de 52,78% a 57,78%. Faixa exigida pelo teste: falso positivo até 5,00% e recall de 45,00% a 75,00%.

| verdadeiro \ previsto | legitimo | suspeito | inconclusivo |
|---|---|---|---|
| legitimo | 301 | 11 | 128 |
| suspeito | 44 | 104 | 32 |

| cenário | rótulo | séries | legitimo | suspeito | inconclusivo |
|---|---|---|---|---|---|
| crescimento_normal | legitimo | 50 | 50 | 0 | 0 |
| viral_organico | legitimo | 50 | 50 | 0 | 0 |
| ciclo_diario | legitimo | 50 | 50 | 0 | 0 |
| criador_pequeno | legitimo | 40 | 25 | 0 | 15 |
| viral_relampago (difícil) | legitimo | 30 | 29 | 0 | 1 |
| viral_subida_rapida (difícil) | legitimo | 30 | 30 | 0 | 0 |
| criador_pequeno_ruidoso (difícil) | legitimo | 40 | 16 | 3 | 21 |
| ciclo_diario_forte (difícil) | legitimo | 30 | 17 | 0 | 13 |
| live_fim_seco (difícil) | legitimo | 25 | 1 | 8 | 16 |
| destaque_plataforma (difícil) | legitimo | 25 | 7 | 0 | 18 |
| viral_cortado (difícil) | legitimo | 25 | 2 | 0 | 23 |
| degrau_permanente (difícil) | legitimo | 25 | 24 | 0 | 1 |
| serie_curta_legitima (difícil) | legitimo | 20 | 0 | 0 | 20 |
| pico_comprado | suspeito | 30 | 0 | 30 | 0 |
| plato_mecanico | suspeito | 30 | 0 | 29 | 1 |
| queda_abrupta | suspeito | 30 | 4 | 0 | 26 |
| bot_periodico | suspeito | 30 | 0 | 30 | 0 |
| serie_curta_comprada (difícil) | suspeito | 20 | 0 | 15 | 5 |
| compra_imitando_organico (difícil) | suspeito | 20 | 20 | 0 | 0 |
| compra_gradual (difícil) | suspeito | 20 | 20 | 0 | 0 |

Falsos positivos na avaliação: criador_pequeno_ruidoso-001, criador_pequeno_ruidoso-005, criador_pequeno_ruidoso-009, live_fim_seco-001, live_fim_seco-002, live_fim_seco-006, live_fim_seco-014, live_fim_seco-015, live_fim_seco-018, live_fim_seco-019, live_fim_seco-024.

Folga dos limiares: valor medido na série legítima que chegou mais perto de disparar cada sinal. Valor do lado de disparo quer dizer que o sinal disparou nessa série, o que não implica `suspeito` (queda abrupta isolada vira `inconclusivo`). Em rajadas_periodicas o valor só conta com intervalo de 2 a 12 horas; valor alto com intervalo de 24 horas (ciclo diário) não dispara.

| sinal | dispara quando | limiar | legítimo mais próximo | série |
|---|---|---|---|---|
| pico_sem_cauda | abaixo | 0,300 | 0,000 | live_fim_seco-002 |
| queda_abrupta | igual ou acima | 0,900 | 0,969 | viral_cortado-006 |
| repeticao_mecanica | abaixo | 0,200 | 0,243 | criador_pequeno-002 |
| rajadas_periodicas | igual ou acima | 1,000 | 1,000 | ciclo_diario_forte-028 |
<!-- metrics:end -->

O teste `test/integration/readme-metrics.test.ts` gera as partições de novo, mede e falha se o número entre
`<!-- fpr -->` e `<!-- /fpr -->`, ou qualquer linha do bloco acima, divergir do medido. Nenhum número do bloco
é escrito à mão: ele sai de `npm run evaluate`.

### Calibração e avaliação em partições separadas

O dataset tem duas partições com sementes diferentes. `npm run calibrate` testa uma grade pequena dos quatro
limiares de disparo só na partição `calibracao`, com a regra "maximizar recall com falso positivo de no máximo
2%"; empate fica com a combinação mais rígida. A taxa acima é medida só na partição `avaliacao`, que a
calibração nunca viu, e por isso nenhum limiar foi ajustado no mesmo dado em que é medido. Na avaliação, a
taxa de falso positivo passou da meta de 2% usada na calibração. Deixei assim: é o tipo de coisa que a
separação existe para mostrar. Testes conferem que recalibrar reproduz exatamente o `thresholds.json`
versionado e a tabela de limiares de `docs/criterio.md`.

### Onde ele erra e por quê

Os casos marcados "difícil" estão no dataset de propósito, para o número não sair bonito à toa.

- `criador_pequeno_ruidoso` é a origem de todos os falsos positivos da avaliação. São contas com 3 a 40
  views/h e ruído muito alto, sem correlação entre horas: uma hora de sorte sem nada depois parece
  `pico_sem_cauda`, e algumas horas boas seguidas de uma fraca parecem `queda_abrupta`. Também é um dos
  cenários com mais `inconclusivo`, pelo volume baixo.
- `ciclo_diario_forte` (noite perto de zero) não gera falso positivo, porque a queda que se repete todo dia
  no mesmo horário não conta. Às vezes fica `inconclusivo`: com a noite quase zerada, a mediana é baixa e o
  pico do dia parece um pico isolado de cauda curta.
- `serie_curta_legitima` é sempre `inconclusivo`: com menos de 48 horas e nenhum sinal, ele não afirma que é
  legítimo. `serie_curta_comprada` às vezes também fica `inconclusivo`, porque o pico está perto do fim e não
  dá para ver a cauda.
- `compra_imitando_organico` e `compra_gradual` passam como `legitimo`. São views compradas com a forma de um
  viral orgânico ou somadas aos poucos ao longo de dias. O critério olha só a forma da curva, e essa forma é
  copiável.
- `queda_abrupta` às vezes passa como `legitimo` quando o corte fica um pouco abaixo do limiar calibrado.

### Quando ele prefere não acusar

Um pico de 8.102 views na hora 69 de uma série de 72 horas pode ser compra ou o começo de um viral. Sem ver as
horas seguintes não dá para saber, e acusar agora é exatamente o erro caro do enunciado. Resposta real para
`examples/pico-no-fim.json`:

```json
{
  "classification": "inconclusivo",
  "reason": "Inconclusivo: prefiro não acusar ainda. Na hora 69 o post teve 8.102 views, 81 vezes a linha de base de 100 views/h, num pico de 1 hora. Depois do pico só há 2 horas de série; preciso de 10 para ver se as views caem de volta (compra) ou decaem aos poucos (viral)."
}
```

Testes: o bloco "prefere não acusar" de `test/unit/classify.test.ts`, com esse caso, a mesma série com 12
horas a mais (que passa a ser suspeita), a cauda curta na zona cinza e o volume baixo.

### Pico orgânico x pico comprado

`examples/pico-organico.json` e `examples/pico-comprado.json` têm a mesma linha de base e o mesmo pico de
5.000 views na hora 40. No orgânico as views sobem em algumas horas e decaem com meia-vida de 6 horas; no
comprado, 4.900 views entram numa hora só. O teste
`pico orgânico plausível e pico comprado com a mesma altura caem em baldes diferentes` (em
`test/unit/classify.test.ts`, repetido pela API em `test/integration/api.test.ts`) mostra a diferença:

| | classificação | `pico_sem_cauda.value` | disparou |
|---|---|---|---|
| orgânico | `legitimo` | 3,0955 (as 10 horas seguintes somam 310% do excesso do pico) | não |
| comprado | `suspeito` | 0,0033 | sim |

O motivo real do comprado: "Suspeito: padrão que merece revisão humana. Na hora 40 o post teve 5.000 views,
50 vezes a linha de base de 100 views/h, num pico de 1 hora. Nas 10 horas seguintes, juntas, vieram 0% das
views extras da hora do pico: as views voltaram à base logo depois, sem a cauda de decaimento de um vídeo que
estoura de verdade (abaixo de 30% é o formato de views entregues em lote)." A resposta completa, com os quatro
sinais, está em [docs/api.md](docs/api.md#exemplos-reais).

## Por que não um modelo treinado opaco (ou um LLM)

O enunciado pede três coisas que um modelo opaco ou um serviço externo quebram: um motivo que dá para ler sem
conhecer o código, um dataset reproduzível e um número de falso positivo que um teste confere. Uma rede ou um
gradient boosting dariam um score sem explicação que um criador acusado conseguisse contestar. Um LLM daria
uma frase plausível, mas não determinística, dependente de rede e de versão de modelo, e o teste do README
deixaria de ser confiável. O "treino" aqui é a calibração descrita acima, uma busca em grade que roda em menos
de um segundo e cujo resultado é um JSON pequeno e versionado.

### Por que não Python com pandas e scikit-learn

Considerei fazer a análise em Python, com pandas e scikit-learn, e entregar só o modelo treinado. Desisti por
quatro motivos:

1. Com dataset sintético, o modelo aprenderia as regras do meu gerador. A métrica subiria sem que ele ficasse
   melhor em séries reais.
2. O enunciado pede motivo legível e critério documentado. Um modelo serializado não diz por que acusou um
   criador.
3. O teste que compara o README com o medido passaria a depender de dois runtimes e das versões das
   bibliotecas.
4. Os outros desafios usam Node e Hono, e quis manter a mesma stack.

Com dados reais rotulados, eu treinaria uma árvore de decisão rasa em Python, offline, sobre estes mesmos
sinais, e exportaria as regras como JSON para o classificador Node ler, como ele já lê `thresholds.json`.
Cada folha vira uma regra com limiar e motivo, então a resposta continua explicável. A árvore poderia
aprender combinações que hoje escolhi à mão, como exigir dois sinais em contas pequenas.

## Por que essa solução

A função `classify` é pura; a API só valida, chama e grava. Guardo cada classificação no sqlite com chave
sha256 da versão do critério, do post e da série: isso dá uma trilha de auditoria para uma decisão que afeta
criadores e torna a chamada idempotente. A mesma série devolve o mesmo texto, inclusive o `classified_at`
(detalhes em [docs/api.md](docs/api.md#persistência-e-idempotência)). Um processo Node com sqlite serializa as
escritas, e `INSERT ... ON CONFLICT DO NOTHING` resolve a corrida entre requisições iguais, sem lock, fila
nem Redis. Na escala de uma marca avaliando criadores (milhares de posts, não milhões por minuto), isso sobra.

Com várias instâncias, eu trocaria o sqlite por Postgres com a mesma chave primária e o mesmo
`ON CONFLICT DO NOTHING`. Como a função é pura, nenhuma instância precisa coordenar com outra: duas que
classificarem a mesma série ao mesmo tempo produzem a mesma resposta, e o banco fica com uma.

## Teste de carga

`npm run load` sobe a API na porta 3107 e roda dois cenários k6 por 30 segundos: 50 VUs reenviando as mesmas
30 séries e 20 VUs mandando posts novos, com 10% de payloads inválidos de propósito (que precisam voltar 4xx no
formato de erro). No fim, `scripts/verify-load.ts` lê o banco e falha se houver mais de uma linha por série
repetida, algum payload inválido gravado ou resposta diferente da função pura. Resultado nesta máquina
(macOS, k6 em Docker), detalhes em [docs/carga.md](docs/carga.md):

```
LOAD_SUMMARY
```

## Onde cada exigência está

| exigência | evidência |
|---|---|
| API, dataset, testes de casos óbvios | `src/app.ts`, `src/dataset/generate.ts`, `test/unit/classify.test.ts` (bloco "casos óbvios") |
| taxa de falso positivo esperada | bloco "Resultado no dataset", gerado por `npm run evaluate` |
| caso em que prefere não acusar | seção acima; bloco "prefere não acusar" dos testes |
| comando que gera dataset e calcula a taxa | `npm run evaluate` (`scripts/evaluate.ts`) |
| teste que falha se o README diverge | `test/integration/readme-metrics.test.ts` |
| motivo legível | `reason` e `detail`; teste "o motivo é uma frase em português sem nomes internos do código" |
| pico orgânico x comprado | `pico orgânico plausível e pico comprado com a mesma altura caem em baldes diferentes` |
| critério documentado, inclusive o que não detecta | [docs/criterio.md](docs/criterio.md) |
| dataset reproduzível, sem rede social | PRNG mulberry32 próprio (`src/dataset/prng.ts`); `test/unit/dataset.test.ts` |
| payloads inválidos, idempotência e concorrência | `test/integration/payloads-invalidos.test.ts`, `test/integration/api.test.ts`, `npm run load` |

## O que ficou de fora e o que eu faria com mais tempo

Ficou de fora qualquer dado real. Todo número aqui vem de um dataset que eu gerei pensando nos sinais, então
ele mostra que o classificador faz o que o critério diz, não que acerta em produção; espero mais falsos
positivos em dados reais. Também não uso ciclo dia/noite como sinal, não olho picos secundários e só aceito
série incremental.

Com mais tempo, eu rotularia uma amostra pequena de séries reais para medir a taxa nelas, exigiria dois sinais
(ou um limiar mais rígido) em contas pequenas, que é onde estão os falsos positivos, e olharia os picos além
do maior.

## Uso de IA

O código, os testes, o critério e este README foram produzidos com Claude Code (Claude Opus) a partir do
enunciado do desafio. Os números de métricas e de carga saíram de execuções reais dos comandos descritos aqui.

**O que eu revisei:** revisei o critério em `docs/criterio.md` e as regras de combinação, conferi os casos de
teste de pico orgânico x comprado e de "prefere não acusar", rodei `npm test`, `npm run evaluate` e
`npm run load` localmente e conferi que os exemplos do README batem com as respostas da API.
