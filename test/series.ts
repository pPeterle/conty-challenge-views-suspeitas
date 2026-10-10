/** Séries montadas à mão para os testes. Determinísticas, sem PRNG, para dar para conferir na cabeça. */

/**
 * Audiência estável em torno de `level`, com uma oscilação fixa de pelo menos dois desvios de Poisson
 * (ou 10%, o que for maior): varia como gente, não como robô.
 */
export function steady(hours: number, level = 100): number[] {
  const amp = Math.max(0.1 * level, 2 * Math.sqrt(level));
  return Array.from({ length: hours }, (_, t) => Math.max(0, Math.round(level + (amp * (((t * 37) % 21) - 10)) / 10)));
}

/** Soma uma onda de viral: sobe em `rise` horas até `extra` views acima da base e decai com meia-vida `halfLife`. */
export function withOrganicPeak(base: number[], at: number, extra: number, rise = 4, halfLife = 6): number[] {
  return base.map((v, t) => {
    if (t < at - rise) return v;
    const wave = t <= at ? extra * Math.exp((-3 * (at - t)) / rise) : extra * 2 ** (-(t - at) / halfLife);
    return v + Math.round(wave);
  });
}

/** Soma um lote comprado: `extra` views em cada uma das `width` horas a partir de `at`, e nada depois. */
export function withBoughtPeak(base: number[], at: number, extra: number, width = 1): number[] {
  return base.map((v, t) => (t >= at && t < at + width ? v + extra : v));
}

export function dailyCycle(hours: number, level = 200, amp = 0.6): number[] {
  return steady(hours, level).map((v, t) => Math.round(v * (1 + amp * Math.sin((2 * Math.PI * t) / 24))));
}
