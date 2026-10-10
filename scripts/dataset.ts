import { mkdirSync, writeFileSync } from "node:fs";
import { generatePartitions } from "../src/dataset/generate.ts";
import { datasetHash } from "../src/evaluation/metrics.ts";

const partitions = generatePartitions();
mkdirSync("data", { recursive: true });
writeFileSync("data/dataset.json", JSON.stringify(partitions));
for (const [name, ds] of Object.entries(partitions)) {
  console.log(`${name}: ${ds.samples.length} séries, semente ${ds.seed}, sha256 ${datasetHash(ds)}`);
}
console.log("gravado em data/dataset.json");
