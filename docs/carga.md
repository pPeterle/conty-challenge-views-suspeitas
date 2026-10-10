# Teste de carga

`npm run load` (`scripts/load.sh`):

1. Gera `load/fixtures.json` com duas séries de cada cenário da partição de avaliação (54 no total) e a
   resposta esperada de cada uma, calculada pela função pura (`scripts/load-fixtures.ts`).
2. Sobe a API na porta 3107 com um banco sqlite temporário em `.load-tmp/`, apagado no fim da rodada.
3. Roda o k6 0.54 em Docker, com as fixtures injetadas antes do script (`load/classify.js`), em dois cenários
   simultâneos de 30 segundos:
   - `repetidas`: 50 VUs reenviando sem parar as mesmas 54 séries. Testa idempotência e determinismo.
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

Thresholds: p95 abaixo de 500 ms em cada cenário, `http_req_failed` abaixo de 1%, checks acima de 99,9% e
100% nos inválidos. O teto de latência é folgado de propósito para a carga passar em máquinas mais lentas; o que
reprova a rodada de verdade são os checks, a taxa de erro e a verificação no banco.

## Resultado

Nesta máquina (macOS, k6 em Docker), em 2026-10-10, com load average entre 3 e 5 medido com `uptime` antes e
depois da rodada. Em rodadas anteriores, com a máquina dividida com outros processos pesados, o p95 chegou a passar de
200 ms sem nenhum erro nem resposta errada; o caminho da requisição medido isoladamente leva menos de 1 ms.

```
     ✓ status 200
     ✓ classificação esperada
     ✓ id esperado
     ✓ mesma série, mesma resposta
     ✓ inválido: status 4xx esperado
     ✓ inválido: erro no formato padrão
   ✓ checks.........................: 100.00% 377994 out of 377994
     ✓ { tipo:invalido }............: 100.00% 6114 out of 6114
     http_req_duration..............: avg=19.01ms min=3.68ms med=16.65ms max=747.54ms p(90)=29.33ms p(95)=33.32ms
     ✓ { scenario:novas }...........: avg=19.28ms min=3.68ms med=16.64ms max=747.54ms p(90)=30.26ms p(95)=33.55ms
     ✓ { scenario:repetidas }.......: avg=18.9ms  min=3.98ms med=16.65ms max=729.24ms p(90)=28.76ms p(95)=33.23ms
   ✓ http_req_failed................: 0.00%   0 out of 109940
     http_reqs......................: 109940  3661.748007/s
verificação ok: 27880 classificações gravadas (54 séries repetidas, uma linha cada; 27826 posts novos, nenhum payload inválido), todas iguais à função pura, API devolvendo o mesmo texto
```
