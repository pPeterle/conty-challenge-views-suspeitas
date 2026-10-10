// Executado pelo k6. FIXTURES é injetado por scripts/load.sh antes deste arquivo (k6 lê o script do stdin).
import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:3107";

// 4xx esperados (payload inválido de propósito) não contam como falha em http_req_failed.
http.setResponseCallback(http.expectedStatuses(200, 400, 413, 415, 422));

export const options = {
  scenarios: {
    // Mesmas 30 séries enviadas sem parar por muitos clientes: testa idempotência e determinismo.
    repetidas: { executor: "constant-vus", vus: 50, duration: "30s", exec: "repeated" },
    // Cada requisição é um post novo: força classificação e gravação de verdade sob concorrência.
    novas: { executor: "constant-vus", vus: 20, duration: "30s", exec: "fresh" },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{scenario:repetidas}": ["p(95)<500"],
    "http_req_duration{scenario:novas}": ["p(95)<500"],
    checks: ["rate>0.999"],
    "checks{tipo:invalido}": ["rate==1"],
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

// Payloads quebrados de propósito. Os que passariam do parse usam post_id "invalido-...", e a verificação final
// confere que nenhum deles foi gravado.
const base = FIXTURES[0].body;
const pts = base.points;
const INVALID = [
  { body: "{", status: 400 },
  { body: "null", status: 400 },
  { body: "[]", status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-curta", points: pts.slice(0, 10) }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-negativa", points: pts.map((p, i) => (i === 3 ? { ...p, views: -5 } : p)) }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-duplicada", points: pts.map((p, i) => (i === 4 ? { ...p, hour: 3 } : p)) }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-data", published_at: "2026-02-30T00:00:00Z" }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-sem-fuso", published_at: "2026-01-01T00:00:00" }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-enorme", points: pts.map((p, i) => (i === 1 ? { ...p, views: 1e308 } : p)) }), status: 400 },
  { body: JSON.stringify({ ...base, post_id: "invalido-futuro", published_at: "2099-01-01T00:00:00Z" }), status: 422 },
  { body: JSON.stringify(base), status: 415, contentType: "text/plain" },
];

export function fresh() {
  if (Math.random() < 0.1) {
    const bad = INVALID[Math.floor(Math.random() * INVALID.length)];
    const res = http.post(`${BASE_URL}/classify`, bad.body, {
      headers: { "content-type": bad.contentType || "application/json" },
      tags: { tipo: "invalido" },
    });
    check(
      res,
      {
        "inválido: status 4xx esperado": (r) => r.status === bad.status,
        "inválido: erro no formato padrão": (r) => {
          try {
            return typeof r.json().error.code === "string";
          } catch (_) {
            return false;
          }
        },
      },
      { tipo: "invalido" },
    );
    return;
  }
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
