import { writeFileSync } from "node:fs";
import { classificationId } from "../src/app.ts";
import { classify } from "../src/classifier/classify.ts";
import { PARTITION_SEEDS, generateDataset } from "../src/dataset/generate.ts";

// Duas séries de cada cenário da partição de avaliação, com a resposta esperada calculada pela função pura.
const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";
const perScenario = new Map<string, number>();
const fixtures = generateDataset(PARTITION_SEEDS.avaliacao)
  .samples.filter((s) => {
    const n = perScenario.get(s.scenario) ?? 0;
    perScenario.set(s.scenario, n + 1);
    return n < 2;
  })
  .map((s) => ({
    body: { post_id: s.id, published_at: PUBLISHED_AT, points: s.views.map((views, hour) => ({ hour, views })) },
    expected_id: classificationId(s.id, PUBLISHED_AT, s.views),
    expected_classification: classify(s.views).classification,
  }));
writeFileSync("load/fixtures.json", JSON.stringify(fixtures));
console.log(`load/fixtures.json: ${fixtures.length} séries`);
