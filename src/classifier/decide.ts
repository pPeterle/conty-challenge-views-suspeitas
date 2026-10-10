import type { Measurements, MeasuredPeak, PeakAnalysis } from "./measure.ts";
import { type FiringThresholds, PARAMS } from "./thresholds.ts";

export type Label = "legitimo" | "suspeito" | "inconclusivo";

export type Rule =
  | "sinal_disparou"
  | "queda_isolada"
  | "cauda_nao_observavel"
  | "cauda_zona_cinza"
  | "volume_baixo"
  | "pouco_historico"
  | "nenhum_sinal";

export interface Fired {
  pico_sem_cauda: boolean;
  queda_abrupta: boolean;
  repeticao_mecanica: boolean;
  patamar_liso: boolean;
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
    pico_sem_cauda: firingPeak(m, thr) !== null,
    queda_abrupta: m.drop !== null && m.drop.value >= thr.drop,
    repeticao_mecanica: m.mechanical !== null && m.mechanical.dispersion < thr.mechanical_dispersion,
    patamar_liso: m.smooth !== null && m.smooth.cv < PARAMS.smooth.maxCv,
    rajadas_periodicas:
      m.periodic.period !== null &&
      m.periodic.period >= p.minPeriod &&
      m.periodic.period <= p.maxPeriod &&
      (m.periodic.fraction ?? 0) >= thr.periodic_fraction,
  };
}

const peakFires = (p: PeakAnalysis, thr: FiringThresholds): p is MeasuredPeak =>
  p.status === "measured" &&
  p.tail < thr.peak_tail &&
  p.width <= PARAMS.peak.maxBlockWidth &&
  p.rise < PARAMS.peak.maxRise;

/** O primeiro pico (o maior, depois os outros do maior para o menor) que tem formato de lote comprado. */
export function firingPeak(m: Measurements, thr: FiringThresholds): MeasuredPeak | null {
  return [m.peak, ...m.otherPeaks].find((p): p is MeasuredPeak => peakFires(p, thr)) ?? null;
}

export function isRegularPlateau(m: Measurements): boolean {
  return m.drop !== null && m.drop.plateauDispersion < PARAMS.drop.regularPlateau;
}

/** Pico relevante sem cauda que não chega a disparar (subida gradual, bloco largo) ou com cauda curta. */
export function isGrayPeak(m: Measurements, thr: FiringThresholds): boolean {
  return m.peak.status === "measured" && m.peak.tail < PARAMS.peak.tailGray && !firedSignals(m, thr).pico_sem_cauda;
}

/**
 * Regras de combinação, na ordem de docs/criterio.md. A primeira que bate decide. Série com menos de
 * PARAMS.minHours nem chega aqui: classify devolve inconclusivo antes de medir.
 */
export function decide(m: Measurements, thr: FiringThresholds, peakViews: number): Decision {
  const fired = firedSignals(m, thr);
  const make = (label: Label, rule: Rule): Decision => ({ label, rule, fired });
  if (Object.values(fired).some(Boolean)) {
    // Queda abrupta sozinha também acontece com gente de verdade (live que termina, post que sai do destaque,
    // viral cortado). Só acusa se outro sinal disparou junto ou se o patamar antes era regular demais.
    const onlyDrop = Object.entries(fired).every(([name, on]) => on === (name === "queda_abrupta"));
    if (onlyDrop && !isRegularPlateau(m)) return make("inconclusivo", "queda_isolada");
    return make("suspeito", "sinal_disparou");
  }
  if (m.peak.status === "unobservable") return make("inconclusivo", "cauda_nao_observavel");
  if (isGrayPeak(m, thr)) return make("inconclusivo", "cauda_zona_cinza");
  if (m.base < PARAMS.lowVolume.maxMedian && peakViews < PARAMS.lowVolume.maxPeak) return make("inconclusivo", "volume_baixo");
  if (m.hours < PARAMS.minHoursForLegit) return make("inconclusivo", "pouco_historico");
  return make("legitimo", "nenhum_sinal");
}
