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
  renderReadmeBlock,
  replaceBlock,
} from "../../src/evaluation/metrics.ts";
import storedCalibration from "../../src/classifier/thresholds.json" with { type: "json" };

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const criterio = readFileSync(new URL("../../docs/criterio.md", import.meta.url), "utf8");
const { calibracao, avaliacao } = generatePartitions();
const evaluation = evaluate(avaliacao);
const calibration = evaluate(calibracao);

describe("taxa de falso positivo do README", () => {
  it("a taxa de falso positivo escrita no README é a medida na partição de avaliação", () => {
    const written = parseReadmeFpr(readme);
    expect(written, "README sem o marcador <!-- fpr -->...<!-- /fpr -->").not.toBeNull();
    // O README guarda 2 casas em porcentagem; comparo com a mesma precisão.
    expect(written!.toFixed(4)).toBe(evaluation.false_positive_rate.toFixed(4));
  });

  it("o bloco de métricas do README é exatamente o que npm run evaluate gera", () => {
    expect(extractBlock(readme)).toBe(renderReadmeBlock(evaluation, calibration));
  });

  it("um README com número escrito à mão diferente do medido é detectado", () => {
    const tampered = readme.replace(/<!-- fpr -->[^<]*<!-- \/fpr -->/, "<!-- fpr -->12,34%<!-- /fpr -->");
    expect(parseReadmeFpr(tampered)).toBeCloseTo(0.1234);
    expect(parseReadmeFpr(tampered)!.toFixed(4)).not.toBe(evaluation.false_positive_rate.toFixed(4));
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
