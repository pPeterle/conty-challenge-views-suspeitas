import { createHash } from "node:crypto";
import { classify, type Label } from "../classifier/classify.ts";
import { CALIBRATED, CLASSIFIER_VERSION, type FiringThresholds } from "../classifier/thresholds.ts";
import type { Dataset, TrueLabel } from "../dataset/generate.ts";
import { decide } from "../classifier/decide.ts";
import { measure } from "../classifier/measure.ts";
import { clopperPearson } from "./binomial.ts";
import { STABILITY_BANDS, type Stability } from "./stability.ts";

type Row = Record<Label, number>;

export interface Metrics {
  classifier_version: string;
  seed: number;
  dataset_sha256: string;
  thresholds: FiringThresholds;
  total: number;
  legit_total: number;
  suspicious_total: number;
  /** Legítimos classificados como suspeito / total de legítimos. */
  false_positive_rate: number;
  /** Suspeitos classificados como suspeito / total de suspeitos. */
  recall: number;
  /** Suspeitos corretos / tudo que foi classificado como suspeito. */
  precision: number;
  inconclusive_rate: Record<TrueLabel, number>;
  /** Intervalo de 95% de Clopper-Pearson para a taxa de falso positivo. */
  false_positive_ci: { low: number; high: number };
  /** A regra atual comparada com alternativas simples, nos mesmos sinais e limiares. */
  rule_comparison: Array<{ rule: string; false_positive_rate: number; recall: number }>;
  confusion: Record<TrueLabel, Row>;
  by_scenario: Record<string, { label: TrueLabel; hard: boolean; total: number } & Row>;
  false_positives: string[];
  /** Para cada sinal, o valor de uma série legítima que chegou mais perto de disparar. Mostra a folga do limiar. */
  legit_margins: Record<string, { threshold: number; fires_when: string; closest: number | null; sample: string | null }>;
}

const emptyRow = (): Row => ({ legitimo: 0, suspeito: 0, inconclusivo: 0 });
const rowTotal = (r: Row): number => r.legitimo + r.suspeito + r.inconclusivo;
const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);

export function datasetHash(dataset: Dataset): string {
  return createHash("sha256").update(JSON.stringify(dataset)).digest("hex");
}

export const RULES: Array<{ rule: string; label: (current: Label, firedCount: number) => Label }> = [
  { rule: "atual (queda isolada não acusa)", label: (current) => current },
  { rule: "um sinal qualquer acusa", label: (current, n) => (n >= 1 ? "suspeito" : current) },
  {
    rule: "dois sinais acusam; um só fica inconclusivo",
    label: (current, n) => (n >= 2 ? "suspeito" : n === 1 ? "inconclusivo" : current),
  },
];

function compareRules(dataset: Dataset, thr: FiringThresholds): Metrics["rule_comparison"] {
  const tallies = RULES.map(() => ({ fp: 0, tp: 0 }));
  let legit = 0;
  let susp = 0;
  for (const s of dataset.samples) {
    if (s.label === "legitimo") legit++;
    else susp++;
    const m = measure(s.views);
    const d = decide(m, thr, Math.max(...s.views));
    const firedCount = Object.values(d.fired).filter(Boolean).length;
    RULES.forEach((r, i) => {
      if (r.label(d.label, firedCount) !== "suspeito") return;
      if (s.label === "legitimo") tallies[i].fp++;
      else tallies[i].tp++;
    });
  }
  return RULES.map((r, i) => ({ rule: r.rule, false_positive_rate: ratio(tallies[i].fp, legit), recall: ratio(tallies[i].tp, susp) }));
}

export function evaluate(dataset: Dataset, thr: FiringThresholds = CALIBRATED): Metrics {
  const confusion: Record<TrueLabel, Row> = { legitimo: emptyRow(), suspeito: emptyRow() };
  const byScenario: Metrics["by_scenario"] = {};
  const falsePositives: string[] = [];
  const margins: Metrics["legit_margins"] = {};
  for (const sample of dataset.samples) {
    const result = classify(sample.views, thr);
    const predicted = result.classification;
    confusion[sample.label][predicted]++;
    const sc = (byScenario[sample.scenario] ??= { label: sample.label, hard: sample.hard, total: 0, ...emptyRow() });
    sc.total++;
    sc[predicted]++;
    if (sample.label === "legitimo" && predicted === "suspeito") falsePositives.push(sample.id);
    for (const sig of result.signals) {
      const m = (margins[sig.name] ??= { threshold: sig.threshold, fires_when: sig.fires_when, closest: null, sample: null });
      if (sample.label !== "legitimo" || sig.value === null) continue;
      if (m.closest === null || (sig.fires_when === "below" ? sig.value < m.closest : sig.value > m.closest)) {
        m.closest = sig.value;
        m.sample = sample.id;
      }
    }
  }
  const legitTotal = rowTotal(confusion.legitimo);
  const suspTotal = rowTotal(confusion.suspeito);
  return {
    classifier_version: CLASSIFIER_VERSION,
    seed: dataset.seed,
    dataset_sha256: datasetHash(dataset),
    thresholds: thr,
    total: dataset.samples.length,
    legit_total: legitTotal,
    suspicious_total: suspTotal,
    false_positive_rate: ratio(confusion.legitimo.suspeito, legitTotal),
    recall: ratio(confusion.suspeito.suspeito, suspTotal),
    precision: ratio(confusion.suspeito.suspeito, confusion.legitimo.suspeito + confusion.suspeito.suspeito),
    false_positive_ci: clopperPearson(confusion.legitimo.suspeito, legitTotal),
    rule_comparison: compareRules(dataset, thr),
    inconclusive_rate: {
      legitimo: ratio(confusion.legitimo.inconclusivo, legitTotal),
      suspeito: ratio(confusion.suspeito.inconclusivo, suspTotal),
    },
    confusion,
    by_scenario: byScenario,
    false_positives: falsePositives,
    legit_margins: margins,
  };
}

const num = (x: number): string => x.toFixed(3).replace(".", ",");
const pct = (x: number): string => `${(x * 100).toFixed(2).replace(".", ",")}%`;

export const README_START = "<!-- metrics:start -->";
export const README_END = "<!-- metrics:end -->";

/**
 * Bloco do README gerado a partir das métricas. Ninguém escreve esses números à mão.
 * Os números principais são da partição de avaliação; a de calibração aparece só para comparação.
 */
export function renderReadmeBlock(evaluation: Metrics, calibration: Metrics, stab: Stability): string {
  const m = evaluation;
  const scenarioRows = Object.entries(m.by_scenario).map(
    ([name, r]) =>
      `| ${name}${r.hard ? " (difícil)" : ""} | ${r.label} | ${r.total} | ${r.legitimo} | ${r.suspeito} | ${r.inconclusivo} |`,
  );
  return [
    README_START,
    `Gerado por \`npm run evaluate\` na partição de **avaliação** (semente ${m.seed}, ${m.total} séries, sha256 ` +
      `\`${m.dataset_sha256.slice(0, 12)}\`), com os limiares calibrados na outra partição. Classificador ${m.classifier_version}.`,
    "",
    `- Taxa de falso positivo: <!-- fpr -->${pct(m.false_positive_rate)}<!-- /fpr --> ` +
      `(${m.confusion.legitimo.suspeito} de ${m.legit_total} legítimos classificados como suspeito)`,
    `- Intervalo de 95% da taxa de falso positivo (Clopper-Pearson, exato): ${pct(m.false_positive_ci.low)} a ` +
      `${pct(m.false_positive_ci.high)}. Com ${m.legit_total} séries legítimas, a taxa medida não é mais precisa que isso.`,
    `- Recall: ${pct(m.recall)} (${m.confusion.suspeito.suspeito} de ${m.suspicious_total} suspeitos detectados)`,
    `- Precisão: ${pct(m.precision)}`,
    `- Inconclusivo: ${pct(m.inconclusive_rate.legitimo)} dos legítimos e ${pct(m.inconclusive_rate.suspeito)} dos suspeitos`,
    `- Para comparar, na partição de calibração (semente ${calibration.seed}): falso positivo ` +
      `${pct(calibration.false_positive_rate)}, recall ${pct(calibration.recall)}`,
    `- Estabilidade em ${stab.rows.length} pares de sementes (calibra em uma, mede na outra): falso positivo de ` +
      `${pct(stab.false_positive_rate.min)} a ${pct(stab.false_positive_rate.max)} e recall de ` +
      `${pct(stab.recall.min)} a ${pct(stab.recall.max)}. Faixa exigida pelo teste: falso positivo até ` +
      `${pct(STABILITY_BANDS.false_positive_rate.max)} e recall de ${pct(STABILITY_BANDS.recall.min)} a ` +
      `${pct(STABILITY_BANDS.recall.max)}.`,
    "",
    "Regra atual comparada com alternativas, com os mesmos sinais e limiares, na mesma partição:",
    "",
    "| regra | falso positivo | recall |",
    "|---|---|---|",
    ...m.rule_comparison.map((r) => `| ${r.rule} | ${pct(r.false_positive_rate)} | ${pct(r.recall)} |`),
    "",
    "| verdadeiro \\ previsto | legitimo | suspeito | inconclusivo |",
    "|---|---|---|---|",
    `| legitimo | ${m.confusion.legitimo.legitimo} | ${m.confusion.legitimo.suspeito} | ${m.confusion.legitimo.inconclusivo} |`,
    `| suspeito | ${m.confusion.suspeito.legitimo} | ${m.confusion.suspeito.suspeito} | ${m.confusion.suspeito.inconclusivo} |`,
    "",
    "| cenário | rótulo | séries | legitimo | suspeito | inconclusivo |",
    "|---|---|---|---|---|---|",
    ...scenarioRows,
    "",
    `Falsos positivos na avaliação: ${m.false_positives.length === 0 ? "nenhum" : m.false_positives.join(", ")}.`,
    "",
    "Folga dos limiares: valor medido na série legítima que chegou mais perto de disparar cada sinal. Valor do " +
      "lado de disparo quer dizer que o sinal disparou nessa série, o que não implica `suspeito` (queda abrupta " +
      "isolada vira `inconclusivo`). Em rajadas_periodicas o valor só conta com intervalo de 2 a 12 horas; valor " +
      "alto com intervalo de 24 horas (ciclo diário) não dispara.",
    "",
    "| sinal | dispara quando | limiar | legítimo mais próximo | série |",
    "|---|---|---|---|---|",
    ...Object.entries(m.legit_margins).map(
      ([name, g]) =>
        `| ${name} | ${g.fires_when === "below" ? "abaixo" : "igual ou acima"} | ${num(g.threshold)} | ` +
        `${g.closest === null ? "nunca avaliado" : num(g.closest)} | ${g.sample ?? "-"} |`,
    ),
    README_END,
  ].join("\n");
}

/** Troca o trecho entre dois marcadores (inclusive) por `block`. */
export function replaceBlock(text: string, block: string, startMark = README_START, endMark = README_END): string {
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark);
  if (start === -1 || end === -1 || end < start) throw new Error(`Texto sem os marcadores ${startMark} e ${endMark}`);
  return text.slice(0, start) + block + text.slice(end + endMark.length);
}

export function extractBlock(text: string, startMark = README_START, endMark = README_END): string | null {
  const start = text.indexOf(startMark);
  const end = text.indexOf(endMark);
  return start === -1 || end === -1 ? null : text.slice(start, end + endMark.length);
}

/** Lê o número entre `<!-- fpr -->` e `<!-- /fpr -->` e devolve como fração (0,0125 para "1,25%"). */
export function parseReadmeFpr(readme: string): number | null {
  const match = readme.match(/<!-- fpr -->\s*([\d.,]+)%\s*<!-- \/fpr -->/);
  return match ? Number(match[1].replace(",", ".")) / 100 : null;
}

/**
 * Compara o README com o que foi medido. Devolve a lista de divergências (vazia quando bate). É o que o teste
 * usa, e também o que prova que um README adulterado é pego.
 */
export function readmeDivergences(readme: string, evaluation: Metrics, calibration: Metrics, stab: Stability): string[] {
  const problems: string[] = [];
  const written = parseReadmeFpr(readme);
  if (written === null) problems.push("README sem o marcador <!-- fpr -->...<!-- /fpr -->");
  else if (written.toFixed(4) !== evaluation.false_positive_rate.toFixed(4)) {
    problems.push(`taxa no README ${pct(written)} difere da medida ${pct(evaluation.false_positive_rate)}`);
  }
  if (extractBlock(readme) !== renderReadmeBlock(evaluation, calibration, stab)) {
    problems.push("bloco de métricas do README difere do gerado por npm run evaluate");
  }
  return problems;
}
