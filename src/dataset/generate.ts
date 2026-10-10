import { Rng } from "./prng.ts";

export type TrueLabel = "legitimo" | "suspeito";

export interface Sample {
  id: string;
  label: TrueLabel;
  scenario: Scenario;
  /** Caso difícil de propósito: perto da fronteira entre os baldes ou fora do que o critério enxerga. */
  hard: boolean;
  views: number[];
}

export interface Dataset {
  seed: number;
  samples: Sample[];
}

export type Partition = "calibracao" | "avaliacao";

/**
 * Duas partições com sementes diferentes. Os limiares são escolhidos só na calibração; a taxa do README é medida
 * só na avaliação, que a calibração nunca vê.
 */
export const PARTITION_SEEDS: Record<Partition, number> = { calibracao: 1001, avaliacao: 2002 };

const logUniform = (rng: Rng, min: number, max: number): number =>
  Math.exp(rng.uniform(Math.log(min), Math.log(max)));

const diurnal = (t: number, amp: number, phase: number): number => 1 + amp * Math.sin((2 * Math.PI * (t + phase)) / 24);

/**
 * Audiência humana: média esperada por hora, multiplicada por um ruído log-normal com correlação entre horas
 * vizinhas (o interesse do público muda aos poucos), e contada como Poisson.
 */
function humanViews(rng: Rng, expected: readonly number[], sigma: number, phi = 0.6): number[] {
  let z = rng.normal();
  return expected.map((m) => {
    z = phi * z + Math.sqrt(1 - phi * phi) * rng.normal();
    return rng.poisson(m * Math.exp(sigma * z - (sigma * sigma) / 2));
  });
}

function dailyAudience(rng: Rng, n: number, level: number, ampRange: [number, number]): number[] {
  const amp = rng.uniform(...ampRange);
  const phase = rng.uniform(0, 24);
  const slope = rng.uniform(-0.003, 0.003);
  return Array.from({ length: n }, (_, t) => level * Math.max(0.3, 1 + slope * t) * diurnal(t, amp, phase));
}

/** Média esperada de um viral: audiência diária, decolagem em `rise` horas, pico e decaimento exponencial. */
function viralCurve(
  rng: Rng,
  n: number,
  riseRange: [number, number],
  halfLifeRange: [number, number],
  baseRange: [number, number] = [20, 300],
  heightRange: [number, number] = [10, 60],
): number[] {
  const base = logUniform(rng, ...baseRange);
  const daily = dailyAudience(rng, n, base, [0.2, 0.5]);
  const start = rng.int(12, n - 36);
  const rise = rng.uniform(...riseRange);
  const top = start + rise;
  const height = base * rng.uniform(...heightRange);
  const halfLife = rng.uniform(...halfLifeRange);
  const newFloor = base * rng.uniform(0.2, 1);
  return daily.map((d, t) => {
    if (t < start) return d;
    const wave = t <= top ? height * Math.exp((-3 * (top - t)) / rise) : height * 2 ** (-(t - top) / halfLife);
    return d + wave + (t >= top ? newFloor : 0);
  });
}

const generators = {
  crescimento_normal(rng, n) {
    const a = logUniform(rng, 50, 2000);
    const rise = rng.uniform(1, 4);
    const tau = rng.uniform(24, 96);
    const floor = rng.uniform(0.05, 0.2);
    const amp = rng.uniform(0.2, 0.5);
    const phase = rng.uniform(0, 24);
    const expected = Array.from(
      { length: n },
      (_, t) => a * ((1 - Math.exp(-(t + 1) / rise)) * Math.exp(-t / tau) + floor) * diurnal(t, amp, phase),
    );
    return humanViews(rng, expected, rng.uniform(0.1, 0.3));
  },

  viral_organico(rng, n) {
    return humanViews(rng, viralCurve(rng, n, [2, 8], [3, 12]), rng.uniform(0.1, 0.3));
  },

  // Caso difícil de propósito: viral real que esfria em poucas horas (ex.: post que surfou um assunto do momento).
  viral_relampago(rng, n) {
    return humanViews(rng, viralCurve(rng, n, [1, 3], [1, 3]), rng.uniform(0.1, 0.3));
  },

  ciclo_diario(rng, n) {
    return humanViews(rng, dailyAudience(rng, n, logUniform(rng, 30, 500), [0.4, 0.8]), rng.uniform(0.1, 0.3));
  },

  criador_pequeno(rng, n) {
    const expected = dailyAudience(rng, n, rng.uniform(1, 15), [0.3, 0.7]);
    const bumps = rng.int(0, 3);
    for (let b = 0; b < bumps; b++) {
      const at = rng.int(0, n - 1);
      const height = expected[at] * rng.uniform(1, 3);
      const halfLife = rng.uniform(2, 6);
      for (let t = at; t < n; t++) expected[t] += height * 2 ** (-(t - at) / halfLife);
    }
    return humanViews(rng, expected, rng.uniform(0.3, 0.5));
  },

  // Audiência concentrada num fuso, com noite perto de zero (metade das séries corta a noite de vez).
  ciclo_diario_forte(rng, n) {
    const level = logUniform(rng, 20, 300);
    const phase = rng.uniform(0, 24);
    const expected =
      rng.random() < 0.5
        ? dailyAudience(rng, n, level, [0.8, 0.95])
        : Array.from({ length: n }, (_, t) => 2 * level * Math.max(0.02, Math.sin((2 * Math.PI * (t + phase)) / 24)));
    return humanViews(rng, expected, rng.uniform(0.1, 0.3));
  },

  // Live: horas de audiência alta, com ruído de gente, que termina de vez quando a transmissão acaba.
  live_fim_seco(rng, n) {
    const base = logUniform(rng, 20, 200);
    const expected = dailyAudience(rng, n, base, [0.2, 0.5]);
    const start = rng.int(12, n - 24);
    const end = start + rng.int(2, 8);
    const level = base * rng.uniform(5, 20);
    for (let t = start; t < end; t++) expected[t] += level;
    return humanViews(rng, expected, rng.uniform(0.15, 0.3));
  },

  // Post em destaque na plataforma por algumas horas: sobe em 1 ou 2 horas, fica alto e sai de uma vez.
  destaque_plataforma(rng, n) {
    const base = logUniform(rng, 20, 200);
    const expected = dailyAudience(rng, n, base, [0.2, 0.5]);
    const start = rng.int(12, n - 36);
    const end = start + rng.int(6, 24);
    const level = base * rng.uniform(3, 10);
    for (let t = start; t < end; t++) expected[t] += level * Math.min(1, (t - start + 1) / 2);
    for (let t = end; t < n; t++) expected[t] *= 1.2;
    return humanViews(rng, expected, rng.uniform(0.15, 0.3));
  },

  // Viral real cortado no meio do decaimento (ex.: a plataforma para de recomendar).
  viral_cortado(rng, n) {
    const viral = viralCurve(rng, n, [2, 6], [6, 12]);
    const floor = dailyAudience(rng, n, viral[0], [0.2, 0.4]);
    const cut = viral.findIndex((v, t) => t > 12 && v > 5 * viral[0]) + rng.int(4, 12);
    const expected = viral.map((v, t) => (t >= cut ? floor[t] * 1.5 : v));
    return humanViews(rng, expected, rng.uniform(0.15, 0.3));
  },

  // Post incorporado num site grande: a audiência sobe de patamar e fica.
  degrau_permanente(rng, n) {
    const base = logUniform(rng, 20, 200);
    const expected = dailyAudience(rng, n, base, [0.2, 0.5]);
    const at = rng.int(12, n - 24);
    const factor = rng.uniform(2, 5);
    for (let t = at; t < n; t++) expected[t] *= factor;
    return humanViews(rng, expected, rng.uniform(0.15, 0.3));
  },

  // Viral real que decola quase de uma hora para outra (ex.: compartilhado por uma conta grande).
  viral_subida_rapida(rng, n) {
    return humanViews(rng, viralCurve(rng, n, [0.3, 1], [3, 12]), rng.uniform(0.1, 0.3));
  },

  // Criador pequeno com ruído alto e sem correlação entre horas: picos isolados por acaso.
  criador_pequeno_ruidoso(rng, n) {
    return humanViews(rng, dailyAudience(rng, n, logUniform(rng, 3, 40), [0.3, 0.7]), rng.uniform(0.8, 1.0), 0);
  },

  serie_curta_legitima(rng, n) {
    return humanViews(rng, dailyAudience(rng, n, logUniform(rng, 30, 500), [0.3, 0.7]), rng.uniform(0.1, 0.3));
  },

  pico_comprado(rng, n) {
    return boughtPeak(rng, n, 12);
  },

  serie_curta_comprada(rng, n) {
    return boughtPeak(rng, n, 4);
  },

  // Não detectável de propósito: views compradas somadas aos poucos, com ruído, ao longo de dias.
  compra_gradual(rng, n) {
    const base = logUniform(rng, 30, 300);
    const daily = dailyAudience(rng, n, base, [0.2, 0.5]);
    const start = rng.int(6, Math.floor(n / 3));
    const ramp = rng.uniform(24, 72);
    const extra = base * rng.uniform(0.5, 2);
    const expected = daily.map((d, t) => d + (t < start ? 0 : extra * Math.min(1, (t - start) / ramp)));
    return humanViews(rng, expected, rng.uniform(0.1, 0.3));
  },

  plato_mecanico(rng, n) {
    const views = humanViews(rng, dailyAudience(rng, n, logUniform(rng, 1, 30), [0.3, 0.6]), 0.3);
    const level = rng.int(100, 1000);
    const jitter = Math.round(level * rng.uniform(0, 0.01));
    const start = rng.int(6, Math.floor(n / 2));
    const end = rng.random() < 0.5 ? n : rng.int(start + 24, n);
    for (let t = start; t < end; t++) views[t] += level + rng.int(-jitter, jitter);
    return views;
  },

  queda_abrupta(rng, n) {
    const base = logUniform(rng, 10, 100);
    const views = humanViews(rng, dailyAudience(rng, n, base, [0.2, 0.5]), rng.uniform(0.1, 0.3));
    const plateau = base * rng.uniform(5, 20);
    const start = rng.int(8, n - 30);
    const end = Math.min(n - 8, start + rng.int(12, 48));
    // Patamar com ruído (não mecânico), para que só a queda denuncie.
    const artificial = humanViews(rng, Array(end - start).fill(plateau), 0.15);
    for (let t = start; t < end; t++) views[t] += artificial[t - start];
    return views;
  },

  bot_periodico(rng, n) {
    const base = logUniform(rng, 10, 100);
    const views = humanViews(rng, dailyAudience(rng, n, base, [0.2, 0.5]), rng.uniform(0.1, 0.3));
    const period = rng.int(3, 8);
    const burst = base * rng.uniform(8, 20);
    for (let t = rng.int(0, period - 1); t < n; t += period) views[t] += Math.round(burst * rng.uniform(0.9, 1.1));
    return views;
  },

  // Caso que o critério não pega, de propósito: pouca audiência real e um lote comprado entregue com a forma
  // de um viral (subida, decaimento exponencial, ruído). Serve para o número de recall mostrar esse limite.
  compra_imitando_organico(rng, n) {
    return humanViews(rng, viralCurve(rng, n, [2, 8], [3, 12], [5, 30], [20, 80]), rng.uniform(0.1, 0.3));
  },
} satisfies Record<string, (rng: Rng, n: number) => number[]>;

export type Scenario = keyof typeof generators;

interface ScenarioSpec {
  label: TrueLabel;
  count: number;
  hours: [number, number];
  hard: boolean;
}

/** Mais legítimos que suspeitos, porque a taxa de falso positivo é o número que importa. */
export const SCENARIOS: Record<Scenario, ScenarioSpec> = {
  crescimento_normal: { label: "legitimo", count: 50, hours: [72, 168], hard: false },
  viral_organico: { label: "legitimo", count: 50, hours: [72, 168], hard: false },
  ciclo_diario: { label: "legitimo", count: 50, hours: [72, 168], hard: false },
  criador_pequeno: { label: "legitimo", count: 40, hours: [72, 168], hard: false },
  viral_relampago: { label: "legitimo", count: 30, hours: [72, 168], hard: true },
  viral_subida_rapida: { label: "legitimo", count: 30, hours: [72, 168], hard: true },
  criador_pequeno_ruidoso: { label: "legitimo", count: 40, hours: [72, 168], hard: true },
  ciclo_diario_forte: { label: "legitimo", count: 30, hours: [72, 168], hard: true },
  live_fim_seco: { label: "legitimo", count: 25, hours: [72, 168], hard: true },
  destaque_plataforma: { label: "legitimo", count: 25, hours: [72, 168], hard: true },
  viral_cortado: { label: "legitimo", count: 25, hours: [72, 168], hard: true },
  degrau_permanente: { label: "legitimo", count: 25, hours: [72, 168], hard: true },
  serie_curta_legitima: { label: "legitimo", count: 20, hours: [24, 47], hard: true },
  pico_comprado: { label: "suspeito", count: 30, hours: [72, 168], hard: false },
  plato_mecanico: { label: "suspeito", count: 30, hours: [72, 168], hard: false },
  queda_abrupta: { label: "suspeito", count: 30, hours: [72, 168], hard: false },
  bot_periodico: { label: "suspeito", count: 30, hours: [72, 168], hard: false },
  serie_curta_comprada: { label: "suspeito", count: 20, hours: [24, 47], hard: true },
  compra_imitando_organico: { label: "suspeito", count: 20, hours: [72, 168], hard: true },
  compra_gradual: { label: "suspeito", count: 20, hours: [72, 168], hard: true },
};

/** Série orgânica com um lote comprado de 1 a 3 horas, com pelo menos `after` horas de série depois dele. */
function boughtPeak(rng: Rng, n: number, after: number): number[] {
  const base = logUniform(rng, 20, 300);
  const views = humanViews(rng, dailyAudience(rng, n, base, [0.2, 0.6]), rng.uniform(0.1, 0.3));
  const width = rng.int(1, 3);
  const start = rng.int(Math.min(12, n - after - width), n - after - width);
  const bought = base * rng.uniform(10, 60);
  for (let t = start; t < start + width; t++) views[t] += Math.round(bought * rng.uniform(0.85, 1.15));
  return views;
}

export function generateSeries(scenario: Scenario, seed: number): number[] {
  const rng = new Rng(seed);
  const n = rng.int(...SCENARIOS[scenario].hours);
  return generators[scenario](rng, n);
}

/** FNV-1a de 32 bits: número estável a partir do nome do cenário. */
function nameHash(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

export function generateDataset(seed: number): Dataset {
  const samples: Sample[] = [];
  for (const scenario of Object.keys(SCENARIOS) as Scenario[]) {
    const spec = SCENARIOS[scenario];
    for (let k = 0; k < spec.count; k++) {
      // Semente por (nome do cenário, k): incluir ou mudar um cenário não altera as séries dos outros.
      const seriesSeed = (Math.imul(seed, 0x9e3779b1) ^ Math.imul(nameHash(scenario) + k + 1, 0x85ebca6b)) >>> 0;
      samples.push({
        id: `${scenario}-${String(k + 1).padStart(3, "0")}`,
        label: spec.label,
        scenario,
        hard: spec.hard,
        views: generateSeries(scenario, seriesSeed),
      });
    }
  }
  return { seed, samples };
}

export function generatePartitions(): Record<Partition, Dataset> {
  return {
    calibracao: generateDataset(PARTITION_SEEDS.calibracao),
    avaliacao: generateDataset(PARTITION_SEEDS.avaliacao),
  };
}
