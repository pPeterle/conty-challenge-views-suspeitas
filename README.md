# Views que não parecem humanas

API que recebe a série de views por hora de um post e responde se o padrão é compatível com audiência
humana: `legitimo`, `suspeito` ou `inconclusivo`, com um motivo em português e os sinais medidos. O
classificador é uma função pura com quatro sinais explicáveis. Ele vem com um dataset sintético reproduzível
e um comando que mede a taxa de falso positivo e escreve o número neste README.

O critério completo, incluindo o que ele não detecta, está em [docs/criterio.md](docs/criterio.md). Escrevi
esse documento antes do código.

## Como rodar

Requer Node 22 ou mais novo (uso `node:sqlite`) e Docker para o teste de carga.

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

`POST /classify`

```json
{
  "post_id": "video-123",
  "published_at": "2026-10-01T00:00:00Z",
  "points": [{ "hour": 0, "views": 120 }, { "hour": 1, "views": 340 }]
}
```

`views` é **incremental**: quantas views o post ganhou naquela hora, não o acumulado. `hour` conta a partir de
0 desde a publicação, em ordem e sem buracos. Escolhi incremental porque todos os sinais olham a forma da curva
hora a hora.

Resposta 200: `id` (sha256 da versão do critério, do post e da série), `classification`, `reason`, `signals`
(cada um com `name`, `value`, `threshold`, `fires_when`, `evaluated`, `fired` e `detail`), `summary` e
`classified_at`.

`GET /classifications/:id` devolve uma classificação já feita. `GET /health` responde `{ ok: true }`.

Erros seguem `{ "error": { "code", "message" } }`:

| status | código | quando |
|---|---|---|
| 400 | `INVALID_JSON` | corpo não é JSON |
| 400 | `SERIES_TOO_SHORT` | menos de 24 horas |
| 400 | `SERIES_TOO_LONG` | mais de 2160 horas (90 dias) |
| 400 | `VALIDATION_ERROR` | campo faltando, hora fora de ordem ou faltando, views negativas ou não inteiras |
| 422 | `SERIES_IN_FUTURE` | `published_at` + horas da série passa do relógio do servidor |
| 404 | `NOT_FOUND` | id ou rota inexistente |

## O critério em uma tela

Quatro sinais, cada um com valor medido e limiar:

| sinal | o que mede | por que separa humano de robô |
|---|---|---|
| `pico_sem_cauda` | quanto das views extras do pico ainda aparece nas 10 horas depois dele | viral é compartilhado e decai aos poucos; lote comprado chega e para |
| `queda_abrupta` | maior queda de uma hora para outra que se sustenta, depois de um patamar de pelo menos 30 views/h | gente desacelera aos poucos; pacote de views acaba de uma vez |
| `repeticao_mecanica` | menor índice de dispersão (variância / média) em janelas de 12 horas | contagem de pessoas oscila pelo menos como uma Poisson; robô entrega 200, 201, 200 |
| `rajadas_periodicas` | fração dos intervalos entre rajadas que são exatamente iguais | pessoas não chegam num relógio |

Regras, na ordem: algum sinal disparou vira `suspeito`. Senão, pico com cauda curta demais para julgar ou
impossível de observar vira `inconclusivo`, assim como volume muito baixo (mediana abaixo de 5 views/h) e série
com menos de 48 horas. O resto é `legitimo`. Os limiares e parâmetros estão em
`src/classifier/thresholds.ts` e `thresholds.json`, e a explicação de cada número está em
[docs/criterio.md](docs/criterio.md).

## Resultado no dataset

<!-- metrics:start -->
Gerado por `npm run evaluate` na partição de **avaliação** (semente 2002, 490 séries, sha256 `d91b8bdf1300`), com os limiares calibrados na outra partição. Classificador 1.0.0.

- Taxa de falso positivo: <!-- fpr -->2,58%<!-- /fpr --> (8 de 310 legítimos classificados como suspeito)
- Recall: 70,56% (127 de 180 suspeitos detectados)
- Precisão: 94,07%
- Inconclusivo: 16,13% dos legítimos e 6,11% dos suspeitos
- Para comparar, na partição de calibração (semente 1001): falso positivo 1,61%, recall 74,44%

| verdadeiro \ previsto | legitimo | suspeito | inconclusivo |
|---|---|---|---|
| legitimo | 252 | 8 | 50 |
| suspeito | 42 | 127 | 11 |

| cenário | rótulo | séries | legitimo | suspeito | inconclusivo |
|---|---|---|---|---|---|
| crescimento_normal | legitimo | 50 | 50 | 0 | 0 |
| viral_organico | legitimo | 50 | 50 | 0 | 0 |
| ciclo_diario | legitimo | 50 | 50 | 0 | 0 |
| criador_pequeno | legitimo | 40 | 30 | 0 | 10 |
| viral_relampago (difícil) | legitimo | 30 | 28 | 0 | 2 |
| viral_subida_rapida (difícil) | legitimo | 30 | 30 | 0 | 0 |
| criador_pequeno_ruidoso (difícil) | legitimo | 40 | 14 | 8 | 18 |
| serie_curta_legitima (difícil) | legitimo | 20 | 0 | 0 | 20 |
| pico_comprado | suspeito | 30 | 0 | 26 | 4 |
| plato_mecanico | suspeito | 30 | 2 | 28 | 0 |
| queda_abrupta | suspeito | 30 | 0 | 30 | 0 |
| bot_periodico | suspeito | 30 | 0 | 30 | 0 |
| serie_curta_comprada (difícil) | suspeito | 20 | 0 | 13 | 7 |
| compra_imitando_organico (difícil) | suspeito | 20 | 20 | 0 | 0 |
| compra_gradual (difícil) | suspeito | 20 | 20 | 0 | 0 |

Falsos positivos na avaliação: criador_pequeno_ruidoso-001, criador_pequeno_ruidoso-004, criador_pequeno_ruidoso-008, criador_pequeno_ruidoso-011, criador_pequeno_ruidoso-014, criador_pequeno_ruidoso-016, criador_pequeno_ruidoso-023, criador_pequeno_ruidoso-035.

Folga dos limiares: valor medido na série legítima que chegou mais perto de disparar cada sinal.

| sinal | dispara quando | limiar | legítimo mais próximo | série |
|---|---|---|---|---|
| pico_sem_cauda | abaixo | 0,100 | 0,147 | criador_pequeno_ruidoso-030 |
| queda_abrupta | igual ou acima | 0,800 | 0,919 | criador_pequeno_ruidoso-016 |
| repeticao_mecanica | abaixo | 0,050 | 0,351 | criador_pequeno-036 |
| rajadas_periodicas | igual ou acima | 1,000 | 0,571 | criador_pequeno_ruidoso-026 |
<!-- metrics:end -->

O teste `test/integration/readme-metrics.test.ts` gera as partições de novo, mede e falha se o número entre
`<!-- fpr -->` e `<!-- /fpr -->`, ou qualquer linha do bloco acima, divergir do medido. Não há número escrito
à mão no bloco: ele sai de `npm run evaluate`.

### Calibração e avaliação em partições separadas

O dataset tem duas partições com sementes diferentes. `npm run calibrate` testa uma grade pequena dos quatro
limiares de disparo só na partição `calibracao`, com a regra "maximizar recall com falso positivo de no máximo
2%". Empate fica com a combinação mais rígida. O resultado vai para `src/classifier/thresholds.json`, que é
versionado e é o que a API lê. A taxa acima é medida só na partição `avaliacao`, que a calibração nunca viu.
Com isso, nenhum limiar foi ajustado no mesmo dado em que é medido. A linha "para comparar" mostra a
diferença entre as duas partições. Na avaliação, a taxa de falso positivo passou da meta de 2% usada na calibração, e
deixei assim: é o tipo de coisa que a separação existe para mostrar.

Um teste confere que rodar a calibração de novo produz exatamente o `thresholds.json` versionado, e outro
confere que a tabela de limiares em `docs/criterio.md` é a gerada.

### Onde ele erra e por quê

Os nomes abaixo são os cenários da tabela. Os casos marcados "difícil" estão no dataset de propósito, para o
número não sair bonito à toa.

- `criador_pequeno_ruidoso` é a origem de todos os falsos positivos da avaliação, e todos por
  `queda_abrupta`. São contas com 3 a 40 views/h e ruído muito alto sem correlação entre horas. Uma sequência de
  horas boas seguida de uma hora fraca fica com o formato de "patamar que acabou". Também é o cenário com mais
  `inconclusivo` entre os legítimos, pelo volume baixo.
- `serie_curta_legitima` é sempre `inconclusivo`: com menos de 48 horas e nenhum sinal, ele não afirma que é
  legítimo.
- `compra_imitando_organico` e `compra_gradual` passam como `legitimo`. São views compradas com a forma de um
  viral orgânico ou somadas aos poucos ao longo de dias. O critério olha só a forma da curva, e essa forma é
  copiável. Estão no dataset para o recall mostrar esse limite.
- `serie_curta_comprada` fica muitas vezes `inconclusivo`: o pico está perto do fim da série e não dá para ver
  se há cauda.
- `pico_comprado` às vezes fica `inconclusivo`: quando o lote cai no horário de pico do ciclo diário, o
  excesso das horas seguintes (que é só o dia normal) põe a cauda na zona cinza.
- `plato_mecanico` às vezes passa como `legitimo`: com o limiar calibrado de dispersão bem rígido, um patamar
  de robô somado a audiência real com ruído não fica regular o bastante.

### Quando ele prefere não acusar

Um pico de 8.102 views na hora 69 de uma série de 72 horas pode ser compra ou o começo de um viral. Sem ver as
horas seguintes não dá para saber, e acusar agora é exatamente o erro caro do enunciado. A resposta real
(`examples/pico-no-fim.json`):

```json
{
  "classification": "inconclusivo",
  "reason": "Inconclusivo: prefiro não acusar ainda. Na hora 69 o post teve 8.102 views, 81 vezes a linha de base de 100/h, num pico de 1 hora. Depois do pico só há 2 horas de série; preciso de 10 para ver se as views caem de volta (compra) ou decaem aos poucos (viral)."
}
```

Testes: `prefere não acusar > pico enorme nas últimas horas da série fica inconclusivo` e, logo depois, a mesma
série com 12 horas a mais, que passa a ser suspeita. Há também o caso da cauda curta (zona cinza) e o de volume
baixo.

### Pico orgânico x pico comprado

`examples/pico-organico.json` e `examples/pico-comprado.json` têm a mesma linha de base e o mesmo pico de
5.000 views na hora 40. No orgânico as views sobem em algumas horas e decaem com meia-vida de 6 horas. No
comprado, 4.900 views entram numa hora só. O teste
`pico orgânico x pico comprado > pico orgânico plausível e pico comprado com a mesma altura caem em baldes diferentes`
(em `test/unit/classify.test.ts`, e repetido pela API em `test/integration/api.test.ts`) mostra a diferença:

| | classificação | `pico_sem_cauda.value` | disparou |
|---|---|---|---|
| orgânico | `legitimo` | 3,0955 (as 10 horas seguintes somam 310% do excesso do pico) | não |
| comprado | `suspeito` | 0,0033 | sim |

## Exemplos reais

Saídas de chamadas reais com a API rodando localmente (`npm run dev`, mas na porta 3107).

```bash
curl -s -X POST localhost:3107/classify -H 'content-type: application/json' -d @examples/pico-comprado.json
```

```json
{
  "id": "22e7260886063166b9d8bf78a73a8e980122a972c6ae85ea9ea475bb06a5c832",
  "post_id": "video-comprado",
  "published_at": "2026-10-01T00:00:00.000Z",
  "classifier_version": "1.0.0",
  "classification": "suspeito",
  "reason": "Suspeito: padrão incompatível com audiência humana. Na hora 40 o post teve 5.000 views, 50 vezes a linha de base de 100/h, num pico de 1 hora. Nas 10 horas seguintes, juntas, vieram 0% das views extras da hora do pico: as views voltaram à base logo depois, sem a cauda de decaimento de um vídeo que estoura de verdade (abaixo de 10% é o formato de views entregues em lote).",
  "signals": [
    {
      "name": "pico_sem_cauda",
      "value": 0.0033,
      "threshold": 0.1,
      "fires_when": "below",
      "evaluated": true,
      "fired": true,
      "detail": "Na hora 40 o post teve 5.000 views, 50 vezes a linha de base de 100/h, num pico de 1 hora. Nas 10 horas seguintes, juntas, vieram 0% das views extras da hora do pico: as views voltaram à base logo depois, sem a cauda de decaimento de um vídeo que estoura de verdade (abaixo de 10% é o formato de views entregues em lote)."
    },
    {
      "name": "queda_abrupta",
      "value": 0.0861,
      "threshold": 0.8,
      "fires_when": "at_or_above",
      "evaluated": true,
      "fired": false,
      "detail": "A maior queda sustentada de uma hora para outra foi de 9%, na hora 41 (dispara a partir de 80%)."
    },
    {
      "name": "repeticao_mecanica",
      "value": 0.343,
      "threshold": 0.05,
      "fires_when": "below",
      "evaluated": true,
      "fired": false,
      "detail": "A janela de 12 horas mais regular (horas 9 a 20) teve índice de dispersão 0,34, variação compatível com pessoas (dispara abaixo de 0,05)."
    },
    {
      "name": "rajadas_periodicas",
      "value": null,
      "threshold": 1,
      "fires_when": "at_or_above",
      "evaluated": false,
      "fired": false,
      "detail": "Não avaliado: 1 rajada encontrada (hora com 3 vezes a base local); são necessárias 4 para falar em periodicidade."
    }
  ],
  "summary": {
    "hours": 96,
    "total_views": 14491,
    "median_views_per_hour": 100,
    "peak_views": 5000,
    "peak_hour": 40
  },
  "classified_at": "2026-10-10T03:36:53.426Z"
}
```

O orgânico, só `classification` e `reason`:

```json
{
  "classification": "legitimo",
  "reason": "Legítimo: nenhum dos 4 sinais disparou. Na hora 40 o post teve 5.000 views, 38,2 vezes a linha de base de 131/h, num pico de 6 horas. Nas 10 horas seguintes, juntas, vieram 310% das views extras da hora do pico: subida seguida de decaimento gradual, como em audiência real. A maior queda sustentada de uma hora para outra foi de 11%, na hora 45 (dispara a partir de 80%). A janela de 12 horas mais regular (horas 9 a 20) teve índice de dispersão 0,34, variação compatível com pessoas (dispara abaixo de 0,05)."
}
```

Série curta demais (`examples/serie-curta.json`, 10 horas):

```
HTTP 400
{"error":{"code":"SERIES_TOO_SHORT","message":"A série tem 10 horas; são necessárias pelo menos 24 para classificar."}}
```

Série que terminaria no futuro (o `pico-comprado.json` com `published_at` trocado para `2026-10-09T00:00:00Z`):

```
HTTP 422
{"error":{"code":"SERIES_IN_FUTURE","message":"A série tem 96 horas a partir de 2026-10-09T00:00:00.000Z, então a última hora começaria em 2026-10-12T23:00:00.000Z, depois do horário atual (2026-10-10T03:36:53.522Z)."}}
```

Enviar `pico-comprado.json` de novo devolve o mesmo texto, byte a byte, inclusive o `classified_at` da primeira
vez.

## Por que não um modelo treinado opaco (ou um LLM)

O enunciado pede três coisas que um modelo opaco ou um serviço externo quebram: um motivo que dá para ler sem
conhecer o código, um dataset reproduzível e um número de falso positivo que um teste confere. Uma rede ou um
gradient boosting dariam um score sem explicação que um criador acusado conseguisse contestar. Um LLM daria
uma frase plausível, mas não determinística, dependente de rede e de versão de modelo, e o teste do README
deixaria de ser confiável. O "treino" aqui é a calibração descrita acima, uma busca em grade que roda em menos de um
segundo e cujo resultado é um JSON pequeno e versionado.

Se houvesse dados reais rotulados, o próximo passo natural seria uma árvore de decisão rasa sobre estes mesmos
sinais. Ela continua legível (cada folha é uma regra como as de hoje) e aprenderia combinações que escolhi à
mão, como exigir dois sinais em contas pequenas.

## Persistência, idempotência e concorrência

O núcleo é a função `classify` (`src/classifier/classify.ts`), sem I/O. A API grava cada classificação no
sqlite (`src/db.ts`), com chave `id = sha256(versão do critério, post_id, published_at, views)`, por dois
motivos:

- Auditoria: a classificação vai embasar a decisão de renovar ou não com um criador. Fica guardado o que foi
  classificado, com qual versão do critério e quando, e dá para consultar depois por `GET /classifications/:id`.
- Idempotência: a mesma série com a mesma versão devolve sempre a mesma resposta, inclusive o
  `classified_at`. A gravação é `INSERT ... ON CONFLICT (id) DO NOTHING` seguida de leitura, então a primeira
  gravação vence e as concorrentes leem a mesma linha.

Quando o critério muda, `CLASSIFIER_VERSION` muda junto e a mesma série passa a gerar outra chave e outra
classificação. A antiga continua no banco.

## Por que essa solução

No teste de carga, um único processo classificou e gravou mais de 60 mil séries novas em 30 segundos, com p95
abaixo de 20 ms, enquanto atendia as repetidas. Um processo Node com sqlite serializa as escritas. Na escala de uma marca avaliando criadores (milhares de posts, não milhões por
minuto), isso sobra. Não precisei de lock, fila nem Redis: a restrição de chave primária resolve a corrida
entre requisições iguais, e não há efeito colateral externo que precise de proteção extra.

Com várias instâncias, eu trocaria o sqlite por Postgres com a mesma chave primária e o mesmo
`ON CONFLICT DO NOTHING`. Como a função é pura, nenhuma instância precisa coordenar com outra: duas que
classificarem a mesma série ao mesmo tempo produzem a mesma resposta, e o banco fica com uma.

## Teste de carga

`npm run load` sobe a API na porta 3107 com banco temporário e roda dois cenários k6 ao mesmo tempo por 30
segundos: 50 VUs reenviando sem parar as mesmas 30 séries (duas de cada cenário da partição de avaliação) e
20 VUs enviando um post novo a cada requisição, o que força classificação e gravação de verdade. Checks:
status 200, classificação igual à da função pura, `id` esperado e resposta idêntica à primeira que aquele VU
viu. Depois, `scripts/verify-load.ts` lê o banco e falha se houver mais de uma linha por série repetida, se
alguma resposta gravada diferir da função pura aplicada à série gravada, ou se a API devolver um texto
diferente do gravado.

Resultado real, nesta máquina (macOS, k6 em Docker):

```
✓ checks.........................: 100.00% 762870 out of 762870
  http_req_duration..............: avg=9.38ms  med=8.04ms  p(90)=14.63ms p(95)=16.83ms
  ✓ { scenario:novas }...........: avg=9.59ms  med=8.02ms  p(90)=15.23ms p(95)=17.39ms
  ✓ { scenario:repetidas }.......: avg=9.3ms   med=8.04ms  p(90)=14.29ms p(95)=16.57ms
✓ http_req_failed................: 0.00%   0 out of 221528
  http_reqs......................: 221528  7381.578351/s
verificação ok: 61651 classificações gravadas (30 séries repetidas, uma linha cada; 61621 posts novos), todas iguais à função pura, API devolvendo o mesmo texto
```

Thresholds: p95 abaixo de 200 ms em cada cenário, menos de 1% de erro, checks acima de 99,9%.

## Onde cada exigência está

| exigência | evidência |
|---|---|
| API, dataset, testes de casos óbvios | `src/app.ts`, `src/dataset/generate.ts`, `test/unit/classify.test.ts` (bloco "casos óbvios") |
| taxa de falso positivo esperada | bloco "Resultado no dataset", gerado por `npm run evaluate` |
| caso em que prefere não acusar | seção acima; testes do bloco "prefere não acusar" |
| comando que gera dataset e calcula a taxa | `npm run evaluate` (`scripts/evaluate.ts`) |
| teste que falha se o README diverge | `test/integration/readme-metrics.test.ts` |
| motivo legível | `reason` e `detail`; teste "o motivo é uma frase em português sem nomes internos do código" |
| pico orgânico x comprado | `pico orgânico plausível e pico comprado com a mesma altura caem em baldes diferentes` |
| critério documentado, inclusive o que não detecta | [docs/criterio.md](docs/criterio.md) |
| dataset reproduzível, sem rede social | PRNG mulberry32 próprio (`src/dataset/prng.ts`); `test/unit/dataset.test.ts` |
| idempotência e concorrência | `test/integration/api.test.ts` (50 envios concorrentes, séries diferentes em paralelo) e `npm run load` |

## O que ficou de fora

- Dados reais. Todo número aqui vem de um dataset que eu gerei pensando nos sinais. Ele mostra que o
  classificador faz o que o critério diz, não que acerta em produção. Em dados reais, espero mais falsos
  positivos do que os medidos.
- Ciclo dia/noite como sinal. Depende do fuso da audiência; ficou documentado como não usado.
- Mais de um pico por série. `pico_sem_cauda` olha só o maior.
- Entrada acumulada. Só aceito incremental; converter seria fácil, mas preferi um formato só.
- Autenticação e qualquer interface.

## O que eu faria diferente com mais tempo

- Rotular uma amostra pequena de séries reais e medir a taxa nelas, separada da sintética.
- Exigir dois sinais (ou um limiar mais rígido) em contas pequenas, que é onde estão os falsos positivos.
- Olhar os picos secundários, não só o maior.
- Guardar o histórico de classificações por post para ver mudanças de padrão entre versões do critério.

## Uso de IA

O código, os testes, o critério e este README foram produzidos com Claude Code (Claude Opus) a partir do
enunciado do desafio. Os números de métricas e de carga saíram de execuções reais dos comandos descritos aqui.

**O que eu revisei** (rascunho, para eu confirmar): revisei o critério em `docs/criterio.md` e as regras de
combinação, conferi os casos de teste de pico orgânico x comprado e de "prefere não acusar", rodei
`npm test`, `npm run evaluate` e `npm run load` localmente e conferi que os exemplos do README batem com as
respostas da API.
