import { decide, type Label } from "./decide.ts";
import { fmtInt, plural } from "./format.ts";
import { measure } from "./measure.ts";
import { buildSignals, type Signal } from "./signals.ts";
import { median } from "./stats.ts";
import { CALIBRATED, type FiringThresholds, PARAMS } from "./thresholds.ts";

export type { Label };

export interface SeriesSummary {
  hours: number;
  total_views: number;
  median_views_per_hour: number;
  peak_views: number;
  peak_hour: number;
}

export interface ClassificationResult {
  classification: Label;
  reason: string;
  signals: Signal[];
  summary: SeriesSummary;
}

function summarize(x: readonly number[]): SeriesSummary {
  let peakHour = 0;
  let total = 0;
  for (let i = 0; i < x.length; i++) {
    total += x[i];
    if (x[i] > x[peakHour]) peakHour = i;
  }
  return {
    hours: x.length,
    total_views: total,
    median_views_per_hour: median(x),
    peak_views: x.length > 0 ? x[peakHour] : 0,
    peak_hour: peakHour,
  };
}

/**
 * Função pura: mesma série e mesmos limiares, mesma resposta. `views[i]` são as views ganhas na hora i desde a
 * publicação. As regras estão em docs/criterio.md.
 */
export function classify(views: readonly number[], thr: FiringThresholds = CALIBRATED): ClassificationResult {
  const summary = summarize(views);
  if (views.length < PARAMS.minHours) {
    return {
      classification: "inconclusivo",
      reason:
        `Inconclusivo: a série tem ${plural(views.length, "hora", "horas")} e o mínimo para examinar é ` +
        `${PARAMS.minHours}.`,
      signals: [],
      summary,
    };
  }

  const m = measure(views);
  const decision = decide(m, thr, summary.peak_views);
  const signals = buildSignals(m, thr, decision.fired);
  const peak = signals[0];

  let reason: string;
  switch (decision.rule) {
    case "sinal_disparou":
      reason = `Suspeito: padrão incompatível com audiência humana. ${signals
        .filter((s) => s.fired)
        .map((s) => s.detail)
        .join(" ")}`;
      break;
    case "cauda_nao_observavel":
      reason = `Inconclusivo: prefiro não acusar ainda. ${peak.detail}`;
      break;
    case "cauda_zona_cinza":
      reason = `Inconclusivo: prefiro não acusar. ${peak.detail}`;
      break;
    case "volume_baixo":
      reason =
        `Inconclusivo: volume baixo demais (mediana de ${fmtInt(summary.median_views_per_hour)} views/h e ` +
        `máximo de ${fmtInt(summary.peak_views)}). Com tão poucas views, ruído normal e padrão artificial ` +
        `ficam parecidos.`;
      break;
    case "pouco_historico":
      reason =
        `Inconclusivo: nenhum sinal suspeito em ${plural(views.length, "hora", "horas")}, mas é cedo para ` +
        `afirmar que a audiência é legítima. Reavalie com ${PARAMS.minHoursForLegit} horas ou mais.`;
      break;
    default:
      reason = `Legítimo: nenhum dos ${signals.length} sinais disparou. ${signals
        .filter((s) => s.evaluated)
        .map((s) => s.detail)
        .join(" ")}`.trim();
  }
  return { classification: decision.label, reason, signals, summary };
}
