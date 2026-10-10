import type { Measurements } from "./measure.ts";
import { type FiringThresholds, PARAMS } from "./thresholds.ts";

export type Label = "legitimo" | "suspeito" | "inconclusivo";

export type Rule =
  | "sinal_disparou"
  | "cauda_nao_observavel"
  | "cauda_zona_cinza"
  | "volume_baixo"
  | "pouco_historico"
  | "nenhum_sinal";

export interface Fired {
  pico_sem_cauda: boolean;
  queda_abrupta: boolean;
  repeticao_mecanica: boolean;
  rajadas_periodicas: boolean;
}

export interface Decision {
  label: Label;
  rule: Rule;
  fired: Fired;
}

export function firedSignals(m: Measurements, thr: FiringThresholds): Fired {
  const p = PARAMS.periodic;
  return {
    pico_sem_cauda:
      m.peak.status === "measured" && m.peak.tail < thr.peak_tail && m.peak.width <= PARAMS.peak.maxBlockWidth,
    queda_abrupta: m.drop !== null && m.drop.value >= thr.drop,
    repeticao_mecanica: m.mechanical !== null && m.mechanical.dispersion < thr.mechanical_dispersion,
    rajadas_periodicas:
      m.periodic.period !== null &&
      m.periodic.period >= p.minPeriod &&
      m.periodic.period <= p.maxPeriod &&
      (m.periodic.fraction ?? 0) >= thr.periodic_fraction,
  };
}

export function isGrayPeak(m: Measurements, thr: FiringThresholds): boolean {
  return (
    m.peak.status === "measured" &&
    m.peak.tail >= thr.peak_tail &&
    m.peak.tail < PARAMS.peak.tailGray &&
    m.peak.width <= PARAMS.peak.maxBlockWidth
  );
}

/**
 * Regras de combinação, na ordem de docs/criterio.md. A primeira que bate decide. Série com menos de
 * PARAMS.minHours nem chega aqui: classify devolve inconclusivo antes de medir.
 */
export function decide(m: Measurements, thr: FiringThresholds, peakViews: number): Decision {
  const fired = firedSignals(m, thr);
  const make = (label: Label, rule: Rule): Decision => ({ label, rule, fired });
  if (Object.values(fired).some(Boolean)) return make("suspeito", "sinal_disparou");
  if (m.peak.status === "unobservable") return make("inconclusivo", "cauda_nao_observavel");
  if (isGrayPeak(m, thr)) return make("inconclusivo", "cauda_zona_cinza");
  if (m.base < PARAMS.lowVolume.maxMedian && peakViews < PARAMS.lowVolume.maxPeak) return make("inconclusivo", "volume_baixo");
  if (m.hours < PARAMS.minHoursForLegit) return make("inconclusivo", "pouco_historico");
  return make("legitimo", "nenhum_sinal");
}
