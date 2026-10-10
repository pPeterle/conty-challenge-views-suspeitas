import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generatePartitions } from "../src/dataset/generate.ts";
import { evaluate, renderReadmeBlock, replaceBlock } from "../src/evaluation/metrics.ts";

// Gera o dataset do zero a partir das sementes, para o número nunca depender de um arquivo editado à mão.
const partitions = generatePartitions();
const evaluation = evaluate(partitions.avaliacao);
const calibration = evaluate(partitions.calibracao);

mkdirSync("data", { recursive: true });
writeFileSync("data/dataset.json", JSON.stringify(partitions));
writeFileSync("data/metrics.json", `${JSON.stringify({ avaliacao: evaluation, calibracao: calibration }, null, 2)}\n`);
console.log("data/dataset.json e data/metrics.json gravados");

const block = renderReadmeBlock(evaluation, calibration);
if (existsSync("README.md")) {
  writeFileSync("README.md", replaceBlock(readFileSync("README.md", "utf8"), block));
  console.log("README.md: bloco de métricas atualizado");
}
console.log(block);
