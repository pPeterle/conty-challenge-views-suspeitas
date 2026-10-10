import { describe, expect, it } from "vitest";
import { PARTITION_SEEDS, SCENARIOS, generateDataset, generatePartitions } from "../../src/dataset/generate.ts";
import { mulberry32 } from "../../src/dataset/prng.ts";
import { datasetHash } from "../../src/evaluation/metrics.ts";

describe("dataset sintético", () => {
  it("é reproduzível: mesma semente gera exatamente o mesmo dataset", () => {
    const a = generatePartitions();
    const b = generatePartitions();
    expect(datasetHash(a.avaliacao)).toBe(datasetHash(b.avaliacao));
    expect(datasetHash(a.calibracao)).toBe(datasetHash(b.calibracao));
  });

  it("calibração e avaliação usam sementes diferentes e não compartilham nenhuma série", () => {
    const { calibracao, avaliacao } = generatePartitions();
    expect(PARTITION_SEEDS.calibracao).not.toBe(PARTITION_SEEDS.avaliacao);
    const calib = new Set(calibracao.samples.map((s) => s.views.join(",")));
    expect(avaliacao.samples.some((s) => calib.has(s.views.join(",")))).toBe(false);
  });

  it("o PRNG é próprio e determinístico", () => {
    const seqA = Array.from({ length: 5 }, mulberry32(42));
    expect(Array.from({ length: 5 }, mulberry32(42))).toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("tem as quantidades de cada cenário, com rótulo verdadeiro e views inteiras não negativas", () => {
    const { samples } = generateDataset(PARTITION_SEEDS.avaliacao);
    const total = Object.values(SCENARIOS).reduce((acc, s) => acc + s.count, 0);
    expect(samples).toHaveLength(total);
    for (const s of samples) {
      expect(s.label).toBe(SCENARIOS[s.scenario].label);
      const [min, max] = SCENARIOS[s.scenario].hours;
      expect(s.views.length).toBeGreaterThanOrEqual(min);
      expect(s.views.length).toBeLessThanOrEqual(max);
      expect(s.views.every((v) => Number.isInteger(v) && v >= 0)).toBe(true);
    }
    expect(samples.filter((s) => s.label === "legitimo").length).toBeGreaterThan(samples.length / 2);
    expect(samples.some((s) => s.hard && s.label === "legitimo")).toBe(true);
    expect(samples.some((s) => s.hard && s.label === "suspeito")).toBe(true);
  });
});
