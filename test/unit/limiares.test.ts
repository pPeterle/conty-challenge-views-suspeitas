import { describe, expect, it } from "vitest";
import { classify } from "../../src/classifier/classify.ts";
import type { SignalName } from "../../src/classifier/signals.ts";
import { CALIBRATED, PARAMS } from "../../src/classifier/thresholds.ts";

/**
 * Para cada limiar, uma série logo abaixo e outra logo acima. As séries são montadas a partir do valor em
 * thresholds.json, então os testes acompanham uma recalibração.
 */
const sig = (views: number[], name: SignalName) => classify(views).signals.find((s) => s.name === name)!;

/** Base constante de 100, pico de 5.100 na hora 40; `tail` views extras nas 10 horas depois, `rise` nas 3 antes. */
function peakSeries({ tail = 0, rise = 0, width = 1 } = {}): number[] {
  return Array.from({ length: 96 }, (_, t) => {
    if (t >= 40 && t < 40 + width) return 5100;
    if (t >= 40 + width && t < 50 + width) return 100 + tail;
    if (t >= 37 && t < 40) return 100 + rise;
    return 100;
  });
}

/** Patamar de 1.000 alternando ±d até a hora 60, depois `after` views por hora (alternando ±afterD). */
function dropSeries(after: number, d = 0, afterD = 0): number[] {
  return Array.from({ length: 96 }, (_, t) =>
    t < 60 ? 1000 + (t % 2 === 0 ? d : -d) : after + (t % 2 === 0 ? afterD : -afterD),
  );
}

/** Para uma série alternando m ± d, o índice de dispersão de 12 horas é 12d² / (11m). Devolve d logo abaixo e logo acima de `limit`. */
function alternatingAround(limit: number, m = 1000): [number, number] {
  const exact = Math.sqrt((limit * 11 * m) / 12);
  const below = Number.isInteger(exact) ? exact - 1 : Math.floor(exact);
  return [below, Math.floor(exact) + 1];
}

describe("limiar de pico_sem_cauda (cauda)", () => {
  // Excesso do pico = 5.000; cauda = 10 × tail / 5.000.
  const exact = Math.round(CALIBRATED.peak_tail * 500);
  it(`cauda logo abaixo de ${CALIBRATED.peak_tail} dispara, logo acima não`, () => {
    const below = sig(peakSeries({ tail: exact - 1 }), "pico_sem_cauda");
    const above = sig(peakSeries({ tail: exact + 1 }), "pico_sem_cauda");
    expect(below.value!).toBeLessThan(CALIBRATED.peak_tail);
    expect(above.value!).toBeGreaterThan(CALIBRATED.peak_tail);
    expect(below.fired).toBe(true);
    expect(above.fired).toBe(false);
  });
});

describe("parâmetros fixos de pico_sem_cauda", () => {
  it(`subida logo abaixo de ${PARAMS.peak.maxRise} ainda é degrau, logo acima não`, () => {
    // Subida = 3 × rise / 5.000.
    const exact = (PARAMS.peak.maxRise * 5000) / 3;
    expect(sig(peakSeries({ rise: Math.floor(exact) - 1 }), "pico_sem_cauda").fired).toBe(true);
    expect(sig(peakSeries({ rise: Math.ceil(exact) + 1 }), "pico_sem_cauda").fired).toBe(false);
  });

  it(`bloco de ${PARAMS.peak.maxBlockWidth} horas dispara, de ${PARAMS.peak.maxBlockWidth + 1} não`, () => {
    expect(sig(peakSeries({ width: PARAMS.peak.maxBlockWidth }), "pico_sem_cauda").fired).toBe(true);
    expect(sig(peakSeries({ width: PARAMS.peak.maxBlockWidth + 1 }), "pico_sem_cauda").fired).toBe(false);
  });
});

describe("limiar de queda_abrupta", () => {
  // Queda = 1 - after / 1.000.
  const exact = Math.round(1000 * (1 - CALIBRATED.drop));
  it(`queda logo abaixo de ${CALIBRATED.drop} não dispara, logo acima dispara`, () => {
    const below = sig(dropSeries(exact + 1), "queda_abrupta");
    const above = sig(dropSeries(exact - 1), "queda_abrupta");
    expect(below.value!).toBeLessThan(CALIBRATED.drop);
    expect(above.value!).toBeGreaterThan(CALIBRATED.drop);
    expect(below.fired).toBe(false);
    expect(above.fired).toBe(true);
  });
});

describe("parâmetro fixo da queda isolada (patamar regular)", () => {
  const [regular, human] = alternatingAround(PARAMS.drop.regularPlateau);
  const after = 50;
  it(`patamar com dispersão logo abaixo de ${PARAMS.drop.regularPlateau} faz a queda acusar; logo acima, inconclusivo`, () => {
    // Depois da queda, 50 ± 10: variação de gente, para só a queda disparar.
    const a = classify(dropSeries(after, regular, 10));
    const b = classify(dropSeries(after, human, 10));
    expect(a.signals.filter((s) => s.fired).map((s) => s.name)).toEqual(["queda_abrupta"]);
    expect(b.signals.filter((s) => s.fired).map((s) => s.name)).toEqual(["queda_abrupta"]);
    expect(a.classification).toBe("suspeito");
    expect(b.classification).toBe("inconclusivo");
  });
});

describe("limiar de repeticao_mecanica", () => {
  const [below, above] = alternatingAround(CALIBRATED.mechanical_dispersion);
  const series = (d: number) => Array.from({ length: 96 }, (_, t) => 1000 + (t % 2 === 0 ? d : -d));
  it(`dispersão logo abaixo de ${CALIBRATED.mechanical_dispersion} dispara, logo acima não`, () => {
    const a = sig(series(below), "repeticao_mecanica");
    const b = sig(series(above), "repeticao_mecanica");
    expect(a.value!).toBeLessThan(CALIBRATED.mechanical_dispersion);
    expect(b.value!).toBeGreaterThan(CALIBRATED.mechanical_dispersion);
    expect(a.fired).toBe(true);
    expect(b.fired).toBe(false);
  });
});

describe("limiar de rajadas_periodicas", () => {
  /** 20 intervalos entre rajadas de 800 sobre base 50: `equal` de 6 horas, o resto de 7. */
  function bursts(equal: number): number[] {
    const intervals = [...Array(equal).fill(6), ...Array(20 - equal).fill(7)];
    const starts = intervals.reduce<number[]>((acc, iv) => [...acc, acc[acc.length - 1] + iv], [12]);
    const views = Array.from({ length: starts[starts.length - 1] + 24 }, () => 50);
    for (const s of starts) views[s] += 800;
    return views;
  }
  const atLeast = Math.ceil(CALIBRATED.periodic_fraction * 20);
  it(`fração de intervalos iguais no limiar (${CALIBRATED.periodic_fraction}) dispara, logo abaixo não`, () => {
    const a = sig(bursts(atLeast), "rajadas_periodicas");
    const b = sig(bursts(atLeast - 1), "rajadas_periodicas");
    expect(a.value!).toBeGreaterThanOrEqual(CALIBRATED.periodic_fraction);
    expect(b.value!).toBeLessThan(CALIBRATED.periodic_fraction);
    expect(a.fired).toBe(true);
    expect(b.fired).toBe(false);
  });
});
