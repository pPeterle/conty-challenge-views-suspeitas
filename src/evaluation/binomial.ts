/** ln Γ(x) pela aproximação de Lanczos (g = 7, 9 coeficientes); erro relativo da ordem de 1e-15. */
function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = c[0];
  const t = z + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

function binomPmf(k: number, n: number, p: number): number {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  return Math.exp(lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1) + k * Math.log(p) + (n - k) * Math.log(1 - p));
}

/** P(X <= k) para X ~ Binomial(n, p). */
export function binomCdf(k: number, n: number, p: number): number {
  let s = 0;
  for (let i = 0; i <= k; i++) s += binomPmf(i, n, p);
  return Math.min(1, s);
}

/** Raiz de f crescente em [0, 1] por bisseção. */
function bisect(f: (p: number) => number, target: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Intervalo de confiança exato de Clopper-Pearson para k sucessos em n. Exato no sentido de que usa a binomial
 * em vez da aproximação normal, que erra feio com poucos casos (como 13 falsos positivos em 515).
 */
export function clopperPearson(k: number, n: number, confidence = 0.95): { low: number; high: number } {
  const alpha = 1 - confidence;
  // low: P(X >= k | p) = alpha/2, que cresce com p.
  const low = k === 0 ? 0 : bisect((p) => 1 - binomCdf(k - 1, n, p), alpha / 2);
  // high: P(X <= k | p) = alpha/2, que decresce com p.
  const high = k === n ? 1 : bisect((p) => -binomCdf(k, n, p), -alpha / 2);
  return { low, high };
}
