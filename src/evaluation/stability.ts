import { generateDataset, PARTITION_SEEDS } from "../dataset/generate.ts";
import { calibrate } from "./calibrate.ts";
import { evaluate } from "./metrics.ts";

/** Pares (calibração, avaliação). O primeiro é o par principal do README. */
export const SEED_PAIRS: Array<[number, number]> = [
  [PARTITION_SEEDS.calibracao, PARTITION_SEEDS.avaliacao],
  [1101, 2102],
  [1201, 2202],
  [1301, 2302],
  [1401, 2402],
];

/**
 * Faixa aceita em todos os pares. Se a calibração em outra semente der número fora disso, o resultado do README
 * depende da semente escolhida e o teste de estabilidade falha.
 */
export const STABILITY_BANDS = {
  false_positive_rate: { min: 0, max: 0.05 },
  recall: { min: 0.45, max: 0.75 },
} as const;

export interface StabilityRow {
  calibration_seed: number;
  evaluation_seed: number;
  false_positive_rate: number;
  recall: number;
}

export interface Stability {
  rows: StabilityRow[];
  false_positive_rate: { min: number; max: number };
  recall: { min: number; max: number };
}

/** Para cada par: calibra na semente de calibração e mede na de avaliação, como o fluxo principal. */
export function stability(pairs = SEED_PAIRS): Stability {
  const rows = pairs.map(([c, e]) => {
    const thr = calibrate(generateDataset(c)).thresholds;
    const m = evaluate(generateDataset(e), thr);
    return { calibration_seed: c, evaluation_seed: e, false_positive_rate: m.false_positive_rate, recall: m.recall };
  });
  const range = (k: "false_positive_rate" | "recall") => ({
    min: Math.min(...rows.map((r) => r[k])),
    max: Math.max(...rows.map((r) => r[k])),
  });
  return { rows, false_positive_rate: range("false_positive_rate"), recall: range("recall") };
}
