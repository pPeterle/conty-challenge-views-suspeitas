# Teste de carga

`npm run load` (`scripts/load.sh`):

1. Gera `load/fixtures.json` com duas séries de cada cenário da partição de avaliação (40 no total) e a
   resposta esperada de cada uma, calculada pela função pura (`scripts/load-fixtures.ts`).
2. Sobe a API na porta 3107 com um banco sqlite temporário em `.load-tmp/`.
3. Roda o k6 0.54 em Docker, com as fixtures injetadas antes do script (`load/classify.js`), em dois cenários
   simultâneos de 30 segundos:
   - `repetidas`: 50 VUs reenviando sem parar as mesmas 40 séries. Testa idempotência e determinismo.
   - `novas`: 20 VUs mandando um post novo a cada requisição, o que força classificação e gravação de
     verdade. Em 10% das iterações, manda um payload inválido de propósito: JSON quebrado, `null`, array,
     série curta, views negativas ou de 1e308, hora repetida, data inexistente ou sem fuso, série no futuro e
     `Content-Type` errado.
4. Roda `scripts/verify-load.ts`, que lê o banco e falha (exit 1) se:
   - houver mais ou menos de uma linha por série repetida;
   - algum payload inválido tiver sido gravado;
   - alguma resposta gravada diferir da função pura aplicada à série gravada;
   - a API devolver para uma série repetida um texto diferente do gravado.
5. Encerra só o processo do servidor que o script subiu.

Checks do k6: status 200, classificação igual à esperada, `id` esperado e resposta idêntica à primeira que
aquele VU viu; nos inválidos, o status 4xx esperado e o erro no formato padrão. Os 4xx esperados não contam
como falha (`http.setResponseCallback(http.expectedStatuses(...))`).

Thresholds: p95 abaixo de 200 ms em cada cenário, `http_req_failed` abaixo de 1%, checks acima de 99,9% e
100% nos inválidos.

## Resultado

Nesta máquina (macOS, k6 em Docker). Durante a rodada a máquina estava dividida com outros processos (load
average entre 13 e 19, medido com `uptime` antes e depois), então os tempos são piores do que numa máquina
dedicada. Em outra rodada, com a máquina ainda mais carregada, o p95 passou de 200 ms e o threshold falhou, sem
nenhum erro nem resposta errada; o caminho da requisição medido isoladamente leva menos de 1 ms.

```
     ✓ status 200
     ✓ classificação esperada
     ✓ id esperado
     ✓ mesma série, mesma resposta
     ✓ inválido: status 4xx esperado
     ✓ inválido: erro no formato padrão
   ✓ checks.........................: 100.00% 331556 out of 331556
     ✓ { tipo:invalido }............: 100.00% 5524 out of 5524
     http_req_duration..............: avg=21.54ms min=3.86ms med=18.22ms max=885.27ms p(90)=33.54ms p(95)=38.55ms
     ✓ { scenario:novas }...........: avg=21.26ms min=4.17ms med=18.13ms max=764.39ms p(90)=32.79ms p(95)=38.03ms
     ✓ { scenario:repetidas }.......: avg=21.66ms min=3.86ms med=18.27ms max=885.27ms p(90)=33.79ms p(95)=38.73ms
   ✓ http_req_failed................: 0.00%   0 out of 96866
     http_reqs......................: 96866   3226.712626/s
verificação ok: 25232 classificações gravadas (40 séries repetidas, uma linha cada; 25192 posts novos, nenhum payload inválido), todas iguais à função pura, API devolvendo o mesmo texto
```
