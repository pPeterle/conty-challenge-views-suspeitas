import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CALIBRATED } from "../../src/classifier/thresholds.ts";
import { generatePartitions } from "../../src/dataset/generate.ts";
import { DOC_END, DOC_START, calibrate, renderThresholdsBlock } from "../../src/evaluation/calibrate.ts";
import {
  README_END,
  README_START,
  evaluate,
  extractBlock,
  parseReadmeFpr,
  readmeDivergences,
  replaceBlock,
} from "../../src/evaluation/metrics.ts";
import storedCalibration from "../../src/classifier/thresholds.json" with { type: "json" };

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const criterio = readFileSync(new URL("../../docs/criterio.md", import.meta.url), "utf8");
const { calibracao, avaliacao } = generatePartitions();
const evaluation = evaluate(avaliacao);
const calibration = evaluate(calibracao);

describe("taxa de falso positivo do README", () => {
  it("a taxa de falso positivo e o bloco de métricas do README são os medidos na partição de avaliação", () => {
    expect(parseReadmeFpr(readme), "README sem o marcador <!-- fpr -->").not.toBeNull();
    expect(readmeDivergences(readme, evaluation, calibration)).toEqual([]);
  });

  it("um README com a taxa trocada à mão é reprovado pela mesma checagem", () => {
    const tampered = readme.replace(/<!-- fpr -->[^<]*<!-- \/fpr -->/, "<!-- fpr -->0,00%<!-- /fpr -->");
    expect(tampered).not.toBe(readme);
    const problems = readmeDivergences(tampered, evaluation, calibration);
    expect(problems.some((p) => p.startsWith("taxa no README 0,00%"))).toBe(true);
  });

  it("um README com uma linha da tabela editada é reprovado", () => {
    const tampered = readme.replace(/\| legitimo \| (\d+) \|/, (_m, n) => `| legitimo | ${Number(n) + 1} |`);
    expect(tampered).not.toBe(readme);
    expect(readmeDivergences(tampered, evaluation, calibration)).toContain(
      "bloco de métricas do README difere do gerado por npm run evaluate",
    );
  });

  it("replaceBlock troca só o trecho entre os marcadores", () => {
    const doc = `antes\n${README_START}\nvelho\n${README_END}\ndepois`;
    expect(replaceBlock(doc, `${README_START}\nnovo\n${README_END}`)).toBe(`antes\n${README_START}\nnovo\n${README_END}\ndepois`);
  });
});

describe("calibração", () => {
  it("os limiares em thresholds.json são os que npm run calibrate escolhe na partição de calibração", () => {
    const result = calibrate(calibracao);
    expect(result).toEqual(storedCalibration);
    expect(CALIBRATED).toEqual(result.thresholds);
  });

  it("a calibração respeita a meta de falso positivo na própria partição", () => {
    const result = calibrate(calibracao);
    expect(result.calibration.false_positive_rate).toBeLessThanOrEqual(result.target_fpr);
    expect(calibration.false_positive_rate).toBe(result.calibration.false_positive_rate);
  });

  it("a tabela de limiares de docs/criterio.md é a gerada pela calibração", () => {
    expect(extractBlock(criterio, DOC_START, DOC_END)).toBe(renderThresholdsBlock(calibrate(calibracao)));
  });
});
