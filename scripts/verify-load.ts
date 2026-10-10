import { readFileSync } from "node:fs";
import { classify } from "../src/classifier/classify.ts";
import { listClassifications, openDb } from "../src/db.ts";

// Depois da carga: uma linha por série, resposta gravada igual à função pura, e a API devolvendo o mesmo texto.
const baseUrl = process.env.BASE_URL ?? "http://localhost:3107";
const fixtures: Array<{ body: unknown; expected_id: string }> = JSON.parse(readFileSync("load/fixtures.json", "utf8"));
const rows = listClassifications(openDb(process.env.DB_PATH!));
const failures: string[] = [];

// Toda linha gravada (repetidas e novas) precisa bater com a função pura aplicada à série gravada.
for (const row of rows) {
  const stored = JSON.parse(row.response_json);
  const fresh = classify(JSON.parse(row.request_json).views);
  for (const key of ["classification", "reason", "signals", "summary"] as const) {
    if (JSON.stringify(stored[key]) !== JSON.stringify(fresh[key])) failures.push(`${row.post_id}: ${key} gravado difere da função pura`);
  }
}
const repeatedRows = rows.filter((r) => !r.post_id.startsWith("carga-"));
if (repeatedRows.length !== fixtures.length) {
  failures.push(`esperava ${fixtures.length} classificações das séries repetidas, achei ${repeatedRows.length}`);
}
const byId = new Map(rows.map((r) => [r.id, r]));
for (const f of fixtures) {
  const row = byId.get(f.expected_id);
  if (!row) {
    failures.push(`classificação ${f.expected_id} não foi gravada`);
    continue;
  }
  const res = await fetch(`${baseUrl}/classify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(f.body),
  });
  if ((await res.text()) !== row.response_json) failures.push(`${row.post_id}: API devolveu resposta diferente da gravada`);
}

if (failures.length > 0) {
  console.error(`verificação FALHOU:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `verificação ok: ${rows.length} classificações gravadas (${fixtures.length} séries repetidas, uma linha cada; ` +
    `${rows.length - repeatedRows.length} posts novos), todas iguais à função pura, API devolvendo o mesmo texto`,
);
