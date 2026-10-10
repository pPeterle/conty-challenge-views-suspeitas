import calibrated from "./thresholds.json" with { type: "json" };

export const CLASSIFIER_VERSION = "1.0.0";

/**
 * Os quatro limiares de disparo, escolhidos por `npm run calibrate` na partição de calibração e gravados em
 * thresholds.json. O classificador só lê; quem escreve é o script de calibração.
 */
export interface FiringThresholds {
  /** pico_sem_cauda dispara com cauda abaixo disto. */
  peak_tail: number;
  /** queda_abrupta dispara com queda igual ou acima disto. */
  drop: number;
  /** repeticao_mecanica dispara com índice de dispersão abaixo disto. */
  mechanical_dispersion: number;
  /** rajadas_periodicas dispara com fração de intervalos iguais igual ou acima disto. */
  periodic_fraction: number;
}

/** Parâmetros fixos: definem o que é medido, não onde se corta. Explicados em docs/criterio.md. */
export const PARAMS = {
  minHours: 24,
  minHoursForLegit: 48,
  lowVolume: { maxMedian: 5, maxPeak: 100 },
  peak: { minRatioToBase: 5, minExcess: 100, blockFraction: 0.5, tailHours: 10, maxBlockWidth: 6, tailGray: 0.8 },
  drop: { windowBefore: 6, windowAfter: 6, minAfterHours: 3, minLevelBefore: 30 },
  mechanical: { window: 12, minMean: 10 },
  periodic: { localWindow: 12, burstRatio: 3, burstMinExcess: 50, minBursts: 4, minPeriod: 2, maxPeriod: 12 },
} as const;

export const CALIBRATED: FiringThresholds = calibrated.thresholds;
