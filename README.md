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
incremental porque todos os sinais olham a forma da curva hora a hora; quem tiver o acumulado pode mandar
`"mode": "cumulative"`, e a API converte depois de checar que a série não diminui. A resposta traz
`classification`, `reason`, `signals` (cada um com valor medido, limiar e se disparou) e um `id` para consultar
depois em `GET /classifications/:id`. `GET /criteria` devolve a versão do critério, os limiares em uso e a
lista do que ele não detecta.

Validação e limites: todo corpo e parâmetro de rota passa por zod (`src/schemas.ts`). Série com menos de 24 ou
mais de 2160 horas, hora repetida, faltando ou fora de ordem, views negativas, fracionárias ou acima de 1
bilhão, série acumulada que diminui e `published_at` sem fuso ou inexistente dão 400. Corpo acima de 1 MB dá 413, `Content-Type` que não é JSON dá 415 e série que termina no
futuro dá 422. Campos extras são ignorados. A tabela completa está em [docs/api.md](docs/api.md#erros).

## O critério em uma tela

| sinal | o que mede | por que separa humano de robô |
|---|---|---|
| `pico_sem_cauda` | quanto das views extras do pico ainda aparece nas 10 horas depois dele, num pico de até 3 horas que chega de uma hora para outra | viral é compartilhado e decai aos poucos; lote comprado chega num degrau e para |
| `queda_abrupta` | maior queda de uma hora para outra que se sustenta, depois de um patamar de pelo menos 30 views/h e maior que 5 desvios de Poisson, sem contar a que se repete no mesmo horário do dia vizinho | pacote de views acaba de uma vez (mas live e destaque também, por isso sozinha não acusa) |
| `repeticao_mecanica` | menor índice de dispersão (variância / média) em janelas de 12 horas | contagem de pessoas oscila pelo menos como uma Poisson; robô entrega 200, 201, 200 |
| `rajadas_periodicas` | fração dos intervalos entre rajadas que são exatamente iguais | pessoas não chegam num relógio |

As regras valem nesta ordem, e a primeira que bate decide:

1. Algum sinal disparou: `suspeito`. Exceção: se só `queda_abrupta` disparou e o patamar antes da queda
   variava como gente, o resultado é `inconclusivo`. Live que termina, post que sai do destaque e viral
   cortado têm esse mesmo formato. Com outro sinal junto, ou patamar regular demais, continua `suspeito`.
2. Pico relevante com cauda curta demais para julgar, ou sem horas suficientes depois dele: `inconclusivo`.
3. Mediana abaixo de 5 views/h e nenhuma hora com 100 views ou mais: `inconclusivo`.
4. Série com menos de 48 horas: `inconclusivo`.
5. Caso contrário: `legitimo`.

`suspeito` quer dizer "merece revisão humana", não fraude comprovada. Os limiares de disparo saem de
`npm run calibrate` e ficam em `src/classifier/thresholds.json`.

## Resultado no dataset

<!-- metrics:start -->
Gerado por `npm run evaluate` na partição de **avaliação** (semente 2002, 795 séries, sha256 `413bba59056b`), com os limiares calibrados na outra partição. Classificador 1.0.0.

- Taxa de falso positivo: <!-- fpr -->2,52%<!-- /fpr --> (13 de 515 legítimos classificados como suspeito)
- Intervalo de 95% da taxa de falso positivo (Clopper-Pearson, exato): 1,35% a 4,28%. Com 515 séries legítimas, a taxa medida não é mais precisa que isso.
- Recall: 67,50% (189 de 280 suspeitos detectados)
- Precisão: 93,56%
- Inconclusivo: 31,46% dos legítimos e 14,29% dos suspeitos
- Para comparar, na partição de calibração (semente 1001): falso positivo 1,55%, recall 65,71%
- Estabilidade em 5 pares de sementes (calibra em uma, mede na outra): falso positivo de 1,75% a 2,91% e recall de 63,21% a 67,50%. Faixa exigida pelo teste: falso positivo até 5,00% e recall de 45,00% a 75,00%.

Regra atual comparada com alternativas, com os mesmos sinais e limiares, na mesma partição:

| regra | falso positivo | recall |
|---|---|---|
| atual (queda isolada não acusa) | 2,52% | 67,50% |
| um sinal qualquer acusa | 19,22% | 80,00% |
| dois sinais acusam; um só fica inconclusivo | 1,75% | 32,14% |

| verdadeiro \ previsto | legitimo | suspeito | inconclusivo |
|---|---|---|---|
| legitimo | 340 | 13 | 162 |
| suspeito | 51 | 189 | 40 |

| cenário | rótulo | séries | legitimo | suspeito | inconclusivo |
|---|---|---|---|---|---|
| crescimento_normal | legitimo | 50 | 50 | 0 | 0 |
| viral_organico | legitimo | 50 | 50 | 0 | 0 |
| ciclo_diario | legitimo | 50 | 50 | 0 | 0 |
| criador_pequeno | legitimo | 40 | 24 | 0 | 16 |
| viral_relampago (difícil) | legitimo | 30 | 29 | 0 | 1 |
| viral_subida_rapida (difícil) | legitimo | 30 | 30 | 0 | 0 |
| criador_pequeno_ruidoso (difícil) | legitimo | 40 | 13 | 4 | 23 |
| ciclo_diario_forte (difícil) | legitimo | 30 | 17 | 0 | 13 |
| live_fim_seco (difícil) | legitimo | 25 | 1 | 6 | 18 |
| destaque_plataforma (difícil) | legitimo | 25 | 2 | 2 | 21 |
| viral_cortado (difícil) | legitimo | 25 | 0 | 1 | 24 |
| degrau_permanente (difícil) | legitimo | 25 | 24 | 0 | 1 |
| dois_virais (difícil) | legitimo | 25 | 25 | 0 | 0 |
| canal_grande_liso (difícil) | legitimo | 25 | 25 | 0 | 0 |
| publico_varios_fusos (difícil) | legitimo | 25 | 0 | 0 | 25 |
| serie_curta_legitima (difícil) | legitimo | 20 | 0 | 0 | 20 |
| pico_comprado | suspeito | 30 | 0 | 29 | 1 |
| plato_mecanico | suspeito | 30 | 0 | 29 | 1 |
| queda_abrupta | suspeito | 30 | 0 | 2 | 28 |
| bot_periodico | suspeito | 30 | 0 | 30 | 0 |
| serie_curta_comprada (difícil) | suspeito | 20 | 0 | 15 | 5 |
| compra_na_semana_do_viral (difícil) | suspeito | 25 | 10 | 13 | 2 |
| plato_ruido_pequeno (difícil) | suspeito | 25 | 0 | 25 | 0 |
| bot_periodico_jitter (difícil) | suspeito | 25 | 0 | 25 | 0 |
| injecao_madrugada (difícil) | suspeito | 25 | 1 | 21 | 3 |
| compra_imitando_organico (difícil) | suspeito | 20 | 20 | 0 | 0 |
| compra_gradual (difícil) | suspeito | 20 | 20 | 0 | 0 |

Falsos positivos na avaliação: criador_pequeno_ruidoso-001, criador_pequeno_ruidoso-005, criador_pequeno_ruidoso-009, criador_pequeno_ruidoso-017, live_fim_seco-001, live_fim_seco-002, live_fim_seco-006, live_fim_seco-014, live_fim_seco-015, live_fim_seco-019, destaque_plataforma-003, destaque_plataforma-020, viral_cortado-009.

Folga dos limiares: valor medido na série legítima que chegou mais perto de disparar cada sinal. Valor do lado de disparo quer dizer que o sinal disparou nessa série, o que não implica `suspeito` (queda abrupta isolada vira `inconclusivo`). Em rajadas_periodicas o valor só conta com intervalo de 2 a 12 horas; valor alto com intervalo de 24 horas (ciclo diário) não dispara.

| sinal | dispara quando | limiar | legítimo mais próximo | série |
|---|---|---|---|---|
| pico_sem_cauda | abaixo | 0,200 | 0,000 | live_fim_seco-008 |
| queda_abrupta | igual ou acima | 0,650 | 0,982 | live_fim_seco-005 |
| repeticao_mecanica | abaixo | 0,200 | 0,243 | criador_pequeno-002 |
| patamar_liso | abaixo | 0,040 | 0,070 | degrau_permanente-021 |
| fora_do_ritmo | abaixo | 0,600 | 0,360 | dois_virais-025 |
| rajadas_periodicas | igual ou acima | 0,800 | 1,000 | ciclo_diario_forte-028 |
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

- `live_fim_seco` é a maior fonte de falso positivo. Uma live de 2 ou 3 horas que começa e termina de uma
  vez tem o formato exato de um lote comprado (degrau sem cauda). Distinguir exigiria saber que houve live,
  e isso não está na série. Lives mais longas ficam `inconclusivo`.
- `criador_pequeno_ruidoso` dá os outros falsos positivos: uma hora de sorte sem nada depois parece
  `pico_sem_cauda`. A queda abrupta nessas contas quase nunca passa de 5 desvios de Poisson e nem é avaliada.
- `viral_cortado`, `destaque_plataforma` e boa parte de `live_fim_seco` ficam `inconclusivo`: cauda curta ou
  queda isolada, que é o formato que eles têm de verdade.
- `queda_abrupta` (o cenário suspeito) agora fica quase sempre `inconclusivo`. O patamar artificial do dataset
  tem ruído de gente, e uma queda assim sozinha não basta para acusar. É a perda de recall que aceitei para não
  acusar live e destaque.
- `ciclo_diario_forte` não gera falso positivo, porque a queda que se repete todo dia no mesmo horário não
  conta. Às vezes fica `inconclusivo`: com a noite quase zerada, a mediana é baixa e o pico do dia parece
  isolado.
- `serie_curta_legitima` é sempre `inconclusivo` (menos de 48 horas); `serie_curta_comprada` às vezes também,
  porque o pico está perto do fim e não dá para ver a cauda.
- `compra_imitando_organico` e `compra_gradual` passam como `legitimo`. O critério olha só a forma da curva, e
  essa forma é copiável.

### O que mudou nesta versão

Testando com formatos de audiência real que o dataset ainda não tinha (live que termina, post que sai do
destaque, viral que perde a recomendação), a versão anterior acusava demais, quase sempre por `queda_abrupta`
disparando sozinha. Mudei quatro coisas:

- queda abrupta isolada, com patamar de variação humana, passou a dar `inconclusivo`;
- a queda só conta se passar de 5 desvios de Poisson do patamar, o que tira o ruído de conta pequena;
- queda que se repete no mesmo horário do dia vizinho deixou de contar (ciclo dia/noite forte);
- `pico_sem_cauda` passou a exigir bloco de até 3 horas que chega de uma vez, o que tira viral cortado e
  destaque.

O dataset ganhou cinco famílias legítimas difíceis (`ciclo_diario_forte`, `live_fim_seco`,
`destaque_plataforma`, `viral_cortado`, `degrau_permanente`), e os limiares foram recalibrados só na partição
de calibração. O número acima é o novo, medido nesse dataset mais difícil. O recall caiu porque o cenário
`queda_abrupta` deixou de ser acusado.

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
50 vezes a linha de base de 100 views/h, num pico de 1 hora. O pico chegou de uma hora para outra. Nas 10
horas seguintes, juntas, vieram 0% das views extras da hora do pico: as views voltaram à base logo depois, sem
a cauda de decaimento de um vídeo que estoura de verdade. Degrau de até 3 horas que some sem cauda (abaixo de
30%) é o formato de views entregues em lote." A resposta completa, com os quatro
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
40 séries e 20 VUs mandando posts novos, com 10% de payloads inválidos de propósito (que precisam voltar 4xx no
formato de erro). No fim, `scripts/verify-load.ts` lê o banco e falha se houver mais de uma linha por série
repetida, algum payload inválido gravado ou resposta diferente da função pura. Resultado nesta máquina
(macOS, k6 em Docker, 2026-10-10), detalhes em
[docs/carga.md](docs/carga.md):

```
✓ checks.........................: 100.00% 381902 out of 381902
✓ { tipo:invalido }............: 100.00% 6440 out of 6440
✓ { scenario:novas }...........: avg=18.79ms med=16.36ms p(90)=28.99ms p(95)=32.93ms
✓ { scenario:repetidas }.......: avg=18.76ms med=16.41ms p(90)=29.22ms p(95)=33.06ms
✓ http_req_failed................: 0.00%   0 out of 111314
http_reqs......................: 111314  3708.235697/s
verificação ok: 28497 classificações gravadas (40 séries repetidas, uma linha cada; 28457 posts novos, nenhum payload inválido), todas iguais à função pura, API devolvendo o mesmo texto
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
| limiares e estabilidade | `test/unit/limiares.test.ts` (série logo abaixo e logo acima de cada limiar); estabilidade em 5 pares de sementes em `test/integration/readme-metrics.test.ts` |
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
