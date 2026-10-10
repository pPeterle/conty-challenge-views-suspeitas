import { mean, median, variance } from "./stats.ts";
import { PARAMS } from "./thresholds.ts";

export type MeasuredPeak = {
  status: "measured";
  /** Linha de base usada para este pico (a mediana da série, ou o nível logo antes dele nos picos secundários). */
  base: number;
  hour: number;
  views: number;
  ratio: number;
  width: number;
  rise: number;
  tail: number;
};
export type PeakAnalysis =
  | { status: "none"; base: number; hour: number; views: number }
  | { status: "unobservable"; base: number; hour: number; views: number; ratio: number; width: number; rise: number; hoursAfter: number }
  | MeasuredPeak;

/**
 * Medidas da série que não dependem dos limiares de disparo. Calcular uma vez e decidir com vários limiares é
 * o que deixa a calibração rápida, e garante que calibração e API usam exatamente a mesma decisão.
 */
export interface Measurements {
  hours: number;
  base: number;
  /** O maior pico da série. É ele que decide zona cinza e cauda não observável. */
  peak: PeakAnalysis;
  /** Outros picos relevantes (até PARAMS.peak.maxExtraPeaks), do maior para o menor, já com cauda medida. */
  otherPeaks: MeasuredPeak[];
  drop: {
    hour: number;
    value: number;
    before: number;
    after: number;
    from: number;
    to: number;
    /** Índice de dispersão (variância / média) das horas antes da queda. */
    plateauDispersion: number;
  } | null;
  mechanical: { start: number; dispersion: number; mean: number; sample: number[] } | null;
  /** Janela de patamar mais lisa entre as que destoam do resto da série; null se nenhuma destoa. */
  smooth: { start: number; cv: number; mean: number } | null;
  periodic: { bursts: number; firstBurst: number; period: number | null; fraction: number | null };
}

const isRelevantPeak = (v: number, base: number): boolean =>
  v >= PARAMS.peak.minRatioToBase * Math.max(base, 1) && v - base >= PARAMS.peak.minExcess;

/** Analisa o pico na hora p: bloco, subida e cauda. Devolve também o bloco, para não analisar o mesmo pico duas vezes. */
function analyzePeak(x: readonly number[], base: number, p: number): { analysis: PeakAnalysis; lo: number; hi: number } {
  const t = PARAMS.peak;
  const excess = x[p] - base;
  if (!isRelevantPeak(x[p], base)) return { analysis: { status: "none", base, hour: p, views: x[p] }, lo: p, hi: p };

  let lo = p;
  let hi = p;
  const blockMin = t.blockFraction * excess;
  while (lo > 0 && x[lo - 1] - base >= blockMin) lo--;
  while (hi < x.length - 1 && x[hi + 1] - base >= blockMin) hi++;
  // Subida: excesso nas horas logo antes do bloco, como fração do excesso do pico. Lote comprado é degrau (perto
  // de 0); viral e destaque sobem aos poucos.
  let riseSum = 0;
  for (let i = Math.max(0, lo - t.riseHours); i < lo; i++) riseSum += Math.max(0, x[i] - base);
  const common = { base, hour: p, views: x[p], ratio: x[p] / Math.max(base, 1), width: hi - lo + 1, rise: riseSum / excess };
  const hoursAfter = x.length - 1 - hi;
  if (hoursAfter < t.tailHours) return { analysis: { status: "unobservable", ...common, hoursAfter }, lo, hi };

  let tailSum = 0;
  for (let i = hi + 1; i <= hi + t.tailHours; i++) tailSum += Math.max(0, x[i] - base);
  return { analysis: { status: "measured", ...common, tail: tailSum / excess }, lo, hi };
}

/**
 * O maior pico e os outros picos relevantes. Uma compra pequena na mesma semana de um viral real não é o maior
 * pico da série, e por isso todos os picos relevantes são examinados, não só o maior.
 */
function measurePeaks(x: readonly number[], base: number): Pick<Measurements, "peak" | "otherPeaks"> {
  let top = 0;
  for (let i = 1; i < x.length; i++) if (x[i] > x[top]) top = i;
  const first = analyzePeak(x, base, top);
  const covered: Array<[number, number]> = [[first.lo, first.hi]];
  const candidates: number[] = [];
  for (let i = 0; i < x.length; i++) {
    const isLocalMax = (i === 0 || x[i] >= x[i - 1]) && (i === x.length - 1 || x[i] > x[i + 1]);
    if (i !== top && isLocalMax && isRelevantPeak(x[i], base)) candidates.push(i);
  }
  candidates.sort((a, b) => x[b] - x[a] || a - b);
  const otherPeaks: MeasuredPeak[] = [];
  for (const p of candidates) {
    if (otherPeaks.length >= PARAMS.peak.maxExtraPeaks) break;
    if (covered.some(([lo, hi]) => p >= lo && p <= hi)) continue;
    // Pico secundário pode estar em cima da cauda de um viral: compara com o nível logo antes dele.
    const before = x.slice(Math.max(0, p - 8), Math.max(0, p - 2));
    const localBase = Math.max(base, before.length > 0 ? median(before) : base);
    const { analysis, lo, hi } = analyzePeak(x, localBase, p);
    covered.push([lo, hi]);
    if (analysis.status === "measured") otherPeaks.push(analysis);
  }
  return { peak: first.analysis, otherPeaks };
}

/** Queda sustentada na hora i (1 - mediana depois / mediana antes), ou null se não há janela completa. */
function sustainedDrop(x: readonly number[], i: number): number | null {
  const t = PARAMS.drop;
  if (i - t.windowBefore < 0 || i + t.minAfterHours > x.length) return null;
  const before = median(x.slice(i - t.windowBefore, i));
  if (before <= 0) return null;
  return 1 - median(x.slice(i, Math.min(x.length, i + t.windowAfter))) / before;
}

/**
 * Queda que se repete no mesmo horário um dia antes ou depois é a noite chegando, não um pacote que acabou.
 * Sem essa regra, audiência com ciclo dia/noite muito forte virava suspeita.
 */
function isSeasonal(x: readonly number[], i: number): boolean {
  const t = PARAMS.drop;
  return [i - t.seasonalLag, i + t.seasonalLag].some((j) => (sustainedDrop(x, j) ?? 0) >= t.seasonalDrop);
}

function measureDrop(x: readonly number[]): Measurements["drop"] {
  const t = PARAMS.drop;
  let best: Measurements["drop"] = null;
  for (let i = t.windowBefore; i + t.minAfterHours - 1 < x.length; i++) {
    const before = median(x.slice(i - t.windowBefore, i));
    if (before < t.minLevelBefore) continue;
    if (isSeasonal(x, i)) continue;
    const after = median(x.slice(i, Math.min(x.length, i + t.windowAfter)));
    if (before - after < t.poissonSigmas * Math.sqrt(before)) continue;
    const hourDrop = x[i - 1] > 0 ? 1 - x[i] / x[i - 1] : 0;
    // As duas coisas precisam acontecer: cair na hora e continuar baixo.
    const value = Math.min(hourDrop, 1 - after / before);
    if (best === null || value > best.value) {
      const plateau = x.slice(Math.max(0, i - t.plateauWindow), i);
      const plateauDispersion = variance(plateau) / Math.max(mean(plateau), 1);
      best = { hour: i, value, before, after, from: x[i - 1], to: x[i], plateauDispersion };
    }
  }
  return best;
}

function measureMechanical(x: readonly number[]): Measurements["mechanical"] {
  const t = PARAMS.mechanical;
  let best: Measurements["mechanical"] = null;
  for (let s = 0; s + t.window <= x.length; s++) {
    const w = x.slice(s, s + t.window);
    const m = mean(w);
    if (m < t.minMean) continue;
    const dispersion = variance(w) / m;
    if (best === null || dispersion < best.dispersion) best = { start: s, dispersion, mean: m, sample: w.slice(0, 6) };
  }
  return best;
}

function measureSmooth(x: readonly number[], base: number): Measurements["smooth"] {
  const t = PARAMS.smooth;
  let best: Measurements["smooth"] = null;
  for (let s = 0; s + t.window <= x.length; s++) {
    const w = x.slice(s, s + t.window);
    const m = mean(w);
    if (m < t.minMean || m < t.minRatioToMedian * Math.max(base, 1)) continue;
    const cv = Math.sqrt(variance(w)) / m;
    if (best === null || cv < best.cv) best = { start: s, cv, mean: m };
  }
  return best;
}

function measurePeriodic(x: readonly number[]): Measurements["periodic"] {
  const t = PARAMS.periodic;
  const starts: number[] = [];
  let previousWasBurst = false;
  for (let i = 0; i < x.length; i++) {
    const local = median(x.slice(Math.max(0, i - t.localWindow), Math.min(x.length, i + t.localWindow + 1)));
    const isBurst = x[i] >= t.burstRatio * Math.max(local, 1) && x[i] - local >= t.burstMinExcess;
    if (isBurst && !previousWasBurst) starts.push(i);
    previousWasBurst = isBurst;
  }
  if (starts.length < t.minBursts) return { bursts: starts.length, firstBurst: starts[0] ?? -1, period: null, fraction: null };
  const intervals = starts.slice(1).map((s, k) => s - starts[k]);
  const counts = new Map<number, number>();
  for (const iv of intervals) counts.set(iv, (counts.get(iv) ?? 0) + 1);
  let period = intervals[0];
  for (const [iv, c] of counts) {
    const current = counts.get(period) ?? 0;
    if (c > current || (c === current && iv < period)) period = iv;
  }
  // Intervalo de referência entre 2 e 12 horas que mais intervalos aceitam com folga de ±1 hora: robô agendado
  // também atrasa ou adianta uma hora. Empate: mais intervalos exatos, depois o menor.
  const tol = t.tolerance;
  let best: { k: number; within: number; exact: number } | null = null;
  for (let k = t.minPeriod; k <= t.maxPeriod; k++) {
    const within = intervals.filter((iv) => Math.abs(iv - k) <= tol).length;
    const exact = counts.get(k) ?? 0;
    if (within > 0 && (best === null || within > best.within || (within === best.within && exact > best.exact))) {
      best = { k, within, exact };
    }
  }
  if (best === null) {
    // Nenhum intervalo na faixa: informa o mais comum (ex.: 24 horas, o ciclo diário), que não dispara.
    return { bursts: starts.length, firstBurst: starts[0], period, fraction: (counts.get(period) ?? 0) / intervals.length };
  }
  return { bursts: starts.length, firstBurst: starts[0], period: best.k, fraction: best.within / intervals.length };
}

export function measure(x: readonly number[]): Measurements {
  const base = median(x);
  return {
    hours: x.length,
    base,
    ...measurePeaks(x, base),
    drop: measureDrop(x),
    mechanical: measureMechanical(x),
    smooth: measureSmooth(x, base),
    periodic: measurePeriodic(x),
  };
}
