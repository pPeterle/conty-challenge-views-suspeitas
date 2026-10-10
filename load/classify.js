// Executado pelo k6. FIXTURES é injetado por scripts/load.sh antes deste arquivo (k6 lê o script do stdin).
import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3107";

export const options = {
  scenarios: {
    // Mesmas 30 séries enviadas sem parar por muitos clientes: testa idempotência e determinismo.
    repetidas: { executor: "constant-vus", vus: 50, duration: "30s", exec: "repeated" },
    // Cada requisição é um post novo: força classificação e gravação de verdade sob concorrência.
    novas: { executor: "constant-vus", vus: 20, duration: "30s", exec: "fresh" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:repetidas}": ["p(95)<200"],
    "http_req_duration{scenario:novas}": ["p(95)<200"],
    checks: ["rate>0.999"],
  },
};

const payloads = FIXTURES.map((f) => JSON.stringify(f.body));
// Primeira resposta que este VU viu para cada série: as seguintes precisam ser idênticas byte a byte.
const seen = {};

export function repeated() {
  const i = (__VU * 7 + __ITER) % FIXTURES.length;
  const f = FIXTURES[i];
  const res = http.post(`${BASE_URL}/classify`, payloads[i], { headers: { "content-type": "application/json" } });
  let json = null;
  try {
    json = res.json();
  } catch (_) {}
  if (seen[i] === undefined && res.status === 200) seen[i] = res.body;
  check(res, {
    "status 200": (r) => r.status === 200,
    "classificação esperada": () => json !== null && json.classification === f.expected_classification,
    "id esperado": () => json !== null && json.id === f.expected_id,
    "mesma série, mesma resposta": (r) => r.body === seen[i],
  });
}

export function fresh() {
  const f = FIXTURES[(__VU + __ITER) % FIXTURES.length];
  const body = JSON.stringify({ ...f.body, post_id: `carga-${__VU}-${__ITER}` });
  const res = http.post(`${BASE_URL}/classify`, body, { headers: { "content-type": "application/json" } });
  let json = null;
  try {
    json = res.json();
  } catch (_) {}
  check(res, {
    "status 200": (r) => r.status === 200,
    "classificação esperada": () => json !== null && json.classification === f.expected_classification,
  });
}
