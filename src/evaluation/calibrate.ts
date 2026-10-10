import { decide } from "../classifier/decide.ts";
import { measure } from "../classifier/measure.ts";
import type { FiringThresholds } from "../classifier/thresholds.ts";
import type { Dataset } from "../dataset/generate.ts";

/** Taxa máxima de falso positivo aceita na calibração. */
export const TARGET_FPR = 0.02;

/**
 * Grade pequena de candidatos, cada lista do valor mais rígido (acusa menos) para o mais frouxo.
 * A ordem importa para o desempate: ver `calibrate`.
 */
export const GRID: { [K in keyof FiringThresholds]: number[] } = {
  peak_tail: [0.1, 0.2, 0.3, 0.4, 0.5],
  drop: [0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6],
  mechanical_dispersion: [0.05, 0.1, 0.2, 0.3, 0.5],
  periodic_fraction: [1, 0.9, 0.8, 0.7, 0.6],
};

export interface CalibrationResult {
  rule: string;
  target_fpr: number;
  seed: number;
  combinations_tested: number;
  combinations_within_target: number;
  thresholds: FiringThresholds;
  calibration: { false_positive_rate: number; recall: number; false_positives: number; true_positives: number };
}

/**
 * Busca em grade: maximiza o recall com falso positivo <= TARGET_FPR. Empate em recall: menos falsos positivos.
 * Empate nos dois: fica o primeiro na ordem da grade, que é o mais rígido (falso positivo custa mais caro).
 */
export function calibrate(dataset: Dataset): CalibrationResult {
  const prepared = dataset.samples.map((s) => ({
    legit: s.label === "legitimo",
    m: measure(s.views),
    peakViews: Math.max(...s.views),
  }));
  const legitTotal = prepared.filter((p) => p.legit).length;
  const suspTotal = prepared.length - legitTotal;

  let best: { thr: FiringThresholds; fp: number; tp: number } | null = null;
  let tested = 0;
  let feasible = 0;
  for (const peak_tail of GRID.peak_tail)
    for (const drop of GRID.drop)
      for (const mechanical_dispersion of GRID.mechanical_dispersion)
        for (const periodic_fraction of GRID.periodic_fraction) {
          const thr = { peak_tail, drop, mechanical_dispersion, periodic_fraction };
          let fp = 0;
          let tp = 0;
          for (const p of prepared) {
            if (decide(p.m, thr, p.peakViews).label !== "suspeito") continue;
            if (p.legit) fp++;
            else tp++;
          }
          tested++;
          if (fp / legitTotal > TARGET_FPR) continue;
          feasible++;
          if (best === null || tp > best.tp || (tp === best.tp && fp < best.fp)) best = { thr, fp, tp };
        }
  if (best === null) throw new Error("Nenhuma combinação da grade respeita a meta de falso positivo.");
  return {
    rule: `maximizar recall com falso positivo <= ${TARGET_FPR * 100}% na partição de calibração`,
    target_fpr: TARGET_FPR,
    seed: dataset.seed,
    combinations_tested: tested,
    combinations_within_target: feasible,
    thresholds: best.thr,
    calibration: {
      false_positive_rate: best.fp / legitTotal,
      recall: best.tp / suspTotal,
      false_positives: best.fp,
      true_positives: best.tp,
    },
  };
}

export const DOC_START = "<!-- thresholds:start -->";
export const DOC_END = "<!-- thresholds:end -->";

const num = (x: number): string => String(x).replace(".", ",");

/** Bloco de docs/criterio.md com os limiares calibrados. Gerado por `npm run calibrate`. */
export function renderThresholdsBlock(c: CalibrationResult): string {
  const pct = (x: number) => `${(x * 100).toFixed(2).replace(".", ",")}%`;
  return [
    DOC_START,
    `Gerado por \`npm run calibrate\` na partição de calibração (semente ${c.seed}). Regra: ${c.rule}. ` +
      `${c.combinations_tested} combinações testadas, ${c.combinations_within_target} dentro da meta.`,
    "",
    "| sinal | dispara quando o valor fica | limiar escolhido | candidatos |",
    "|---|---|---|---|",
    `| pico_sem_cauda | abaixo de | ${num(c.thresholds.peak_tail)} | ${GRID.peak_tail.map(num).join("; ")} |`,
    `| queda_abrupta | igual ou acima de | ${num(c.thresholds.drop)} | ${GRID.drop.map(num).join("; ")} |`,
    `| repeticao_mecanica | abaixo de | ${num(c.thresholds.mechanical_dispersion)} | ${GRID.mechanical_dispersion.map(num).join("; ")} |`,
    `| rajadas_periodicas | igual ou acima de | ${num(c.thresholds.periodic_fraction)} | ${GRID.periodic_fraction.map(num).join("; ")} |`,
    "",
    `Na calibração: falso positivo ${pct(c.calibration.false_positive_rate)}, recall ${pct(c.calibration.recall)}.`,
    DOC_END,
  ].join("\n");
}
