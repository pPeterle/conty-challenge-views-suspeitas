import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PARTITION_SEEDS, generateDataset } from "../src/dataset/generate.ts";
import { DOC_END, DOC_START, calibrate, renderThresholdsBlock } from "../src/evaluation/calibrate.ts";
import { replaceBlock } from "../src/evaluation/metrics.ts";

// Só a partição de calibração entra aqui. A de avaliação fica para `npm run evaluate`.
const result = calibrate(generateDataset(PARTITION_SEEDS.calibracao));
writeFileSync("src/classifier/thresholds.json", `${JSON.stringify(result, null, 2)}\n`);
console.log("src/classifier/thresholds.json atualizado");

const doc = "docs/criterio.md";
if (existsSync(doc)) {
  writeFileSync(doc, replaceBlock(readFileSync(doc, "utf8"), renderThresholdsBlock(result), DOC_START, DOC_END));
  console.log(`${doc}: tabela de limiares atualizada`);
}
console.log(renderThresholdsBlock(result));
