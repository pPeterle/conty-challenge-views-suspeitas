# API

## `POST /classify`

```json
{
  "post_id": "video-123",
  "published_at": "2026-10-01T00:00:00Z",
  "points": [{ "hour": 0, "views": 120 }, { "hour": 1, "views": 340 }]
}
```

- `views` é **incremental**: quantas views o post ganhou naquela hora, não o acumulado.
- `hour` conta a partir de 0 desde a publicação, em ordem, sem buraco e sem repetição. A posição no array é a
  hora.
- `published_at` precisa ser data e hora ISO 8601 que exista no calendário, com fuso (`Z` ou `±hh:mm`). Volta
  normalizado para UTC. Sem fuso, a hora 0 dependeria do fuso do servidor.
- `post_id` é aparado nas pontas e aceita qualquer texto de 1 a 200 caracteres.
- Campos extras são ignorados e não são gravados.

Toda entrada passa por zod (`src/schemas.ts`), com um único ponto que converte o erro do zod no formato da
API (`validationError` em `src/app.ts`). Os tipos do handler saem do schema com `z.infer`.

Resposta 200: `id` (sha256 da versão do critério, do post e da série), `post_id`, `published_at`,
`classifier_version`, `classification`, `reason`, `signals`, `summary` e `classified_at`. Cada sinal traz
`name`, `value`, `threshold`, `fires_when` (`below` ou `at_or_above`), `evaluated`, `fired` e `detail`.

## `GET /classifications/:id`

Devolve uma classificação já feita, com o mesmo texto de `POST /classify`. `id` precisa ser um sha256 em
hexadecimal (400 se não for, 404 se não existir).

## `GET /health`

`{ "ok": true, "classifier_version": "1.0.0" }`.

## Erros

Formato: `{ "error": { "code", "message", "details"? } }`. `details` aparece nos erros de validação, com
`path` e `message` de cada campo recusado.

| status | código | quando |
|---|---|---|
| 400 | `INVALID_JSON` | corpo vazio ou que não é JSON (inclusive `NaN` literal) |
| 400 | `SERIES_TOO_SHORT` | menos de 24 horas |
| 400 | `SERIES_TOO_LONG` | mais de 2160 horas (90 dias) |
| 400 | `VALIDATION_ERROR` | corpo que não é objeto, campo ausente ou de tipo errado, `post_id` vazio, `published_at` inválido ou sem fuso, hora repetida, faltando ou fora de ordem, views negativas, fracionárias ou acima de 1 bilhão, `id` malformado |
| 413 | `PAYLOAD_TOO_LARGE` | corpo acima de 1 MB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` ausente ou diferente de JSON |
| 422 | `SERIES_IN_FUTURE` | `published_at` + horas da série passa do relógio do servidor |
| 404 | `NOT_FOUND` | id inexistente, rota inexistente ou método não suportado |
| 500 | `INTERNAL_ERROR` | erro inesperado; mensagem genérica, detalhe só no log do servidor |

Todos esses casos estão em `test/integration/payloads-invalidos.test.ts`, que também confere que nenhum deles
grava nada.

## Persistência e idempotência

O núcleo é a função `classify` (`src/classifier/classify.ts`), sem I/O. A API grava cada classificação no
sqlite (`src/db.ts`, WAL e `busy_timeout`) com chave primária
`id = sha256(versão do critério, post_id, published_at, views)`. Guardo por dois motivos:

- Auditoria: a classificação embasa a decisão de renovar ou não com um criador. Fica registrado o que foi
  classificado, com qual versão do critério e quando.
- Idempotência: a mesma série com a mesma versão devolve sempre o mesmo texto, inclusive o `classified_at`
  da primeira vez. A gravação é `INSERT ... ON CONFLICT (id) DO NOTHING` seguida de leitura, então a primeira
  gravação vence e as concorrentes leem a mesma linha.

Quando o critério muda, `CLASSIFIER_VERSION` muda junto e a mesma série passa a gerar outra chave. A
classificação antiga continua no banco.

## Exemplos reais

Saídas de chamadas reais, com a API rodando na porta 3107.

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
  "reason": "Suspeito: padrão que merece revisão humana. Na hora 40 o post teve 5.000 views, 50 vezes a linha de base de 100 views/h, num pico de 1 hora. Nas 10 horas seguintes, juntas, vieram 0% das views extras da hora do pico: as views voltaram à base logo depois, sem a cauda de decaimento de um vídeo que estoura de verdade (abaixo de 30% é o formato de views entregues em lote).",
  "signals": [
    {
      "name": "pico_sem_cauda",
      "value": 0.0033,
      "threshold": 0.3,
      "fires_when": "below",
      "evaluated": true,
      "fired": true,
      "detail": "Na hora 40 o post teve 5.000 views, 50 vezes a linha de base de 100 views/h, num pico de 1 hora. Nas 10 horas seguintes, juntas, vieram 0% das views extras da hora do pico: as views voltaram à base logo depois, sem a cauda de decaimento de um vídeo que estoura de verdade (abaixo de 30% é o formato de views entregues em lote)."
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
      "threshold": 0.2,
      "fires_when": "below",
      "evaluated": true,
      "fired": false,
      "detail": "A janela de 12 horas mais regular (horas 9 a 20) teve índice de dispersão 0,34, variação compatível com pessoas (dispara abaixo de 0,20)."
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
  "classified_at": "2026-10-10T04:09:41.141Z"
}
```

Erros (corpo e status reais):

```
# examples/serie-curta.json (10 horas)
HTTP 400
{"error":{"code":"SERIES_TOO_SHORT","message":"points: precisa ter pelo menos 24 horas para classificar","details":[{"path":"points","message":"precisa ter pelo menos 24 horas para classificar"}]}}

# pico-comprado.json com points[4].hour trocado para 3
HTTP 400
{"error":{"code":"VALIDATION_ERROR","message":"points[4].hour: hora 3 repetida","details":[{"path":"points[4].hour","message":"hora 3 repetida"}]}}

# pico-comprado.json com published_at 2026-02-30T00:00:00Z
HTTP 400
{"error":{"code":"VALIDATION_ERROR","message":"published_at: precisa ser data e hora ISO 8601 existente com fuso, ex. 2026-10-01T12:00:00Z ou 2026-10-01T09:00:00-03:00","details":[{"path":"published_at","message":"precisa ser data e hora ISO 8601 existente com fuso, ex. 2026-10-01T12:00:00Z ou 2026-10-01T09:00:00-03:00"}]}}

# pico-comprado.json com published_at 2026-10-09T00:00:00Z
HTTP 422
{"error":{"code":"SERIES_IN_FUTURE","message":"A série tem 96 horas a partir de 2026-10-09T00:00:00.000Z, então a última hora começaria em 2026-10-12T23:00:00.000Z, depois do horário atual (2026-10-10T04:09:41.326Z)."}}

# sem Content-Type
HTTP 415
{"error":{"code":"UNSUPPORTED_MEDIA_TYPE","message":"Envie o corpo como JSON, com Content-Type: application/json."}}
```

Enviar `pico-comprado.json` de novo devolve o mesmo texto, byte a byte, e `GET /classifications/<id>`
devolve 200 com o mesmo corpo.
