import { describe, expect, it } from "vitest";
import { classify } from "../../src/classifier/classify.ts";
import type { SignalName } from "../../src/classifier/signals.ts";
import { CALIBRATED, PARAMS } from "../../src/classifier/thresholds.ts";
import { dailyCycle, steady, withBoughtPeak, withOrganicPeak } from "../series.ts";

const signal = (result: ReturnType<typeof classify>, name: SignalName) => {
  const s = result.signals.find((x) => x.name === name);
  if (!s) throw new Error(`sinal ${name} ausente`);
  return s;
};

describe("pico orgânico x pico comprado", () => {
  const base = steady(96, 100);
  const organic = withOrganicPeak(base, 40, 4900);
  const bought = withBoughtPeak(base, 40, organic[40] - base[40]);

  it("pico orgânico plausível e pico comprado com a mesma altura caem em baldes diferentes", () => {
    expect(bought[40]).toBe(organic[40]);
    expect(Math.max(...bought)).toBe(Math.max(...organic));

    const organicResult = classify(organic);
    const boughtResult = classify(bought);

    expect(organicResult.classification).toBe("legitimo");
    expect(boughtResult.classification).toBe("suspeito");

    const organicTail = signal(organicResult, "pico_sem_cauda");
    const boughtTail = signal(boughtResult, "pico_sem_cauda");
    expect(organicTail.evaluated && boughtTail.evaluated).toBe(true);
    expect(organicTail.fired).toBe(false);
    expect(boughtTail.fired).toBe(true);
    // A cauda do orgânico soma mais que o próprio pico; a do comprado é praticamente zero.
    expect(organicTail.value!).toBeGreaterThan(1);
    expect(boughtTail.value!).toBeLessThan(0.05);
    expect(boughtResult.reason).toContain("hora 40");
    expect(boughtResult.reason).toContain("voltaram à base");
  });

  it("um lote comprado de 3 horas seguidas também não tem cauda", () => {
    const result = classify(withBoughtPeak(base, 40, 3000, 3));
    expect(result.classification).toBe("suspeito");
    expect(signal(result, "pico_sem_cauda").fired).toBe(true);
  });
});

describe("patamar liso", () => {
  // Ruído determinístico de ±2% em torno de 3.000 views/h.
  const wiggle = (t: number) => ((t * 37) % 21) / 10 - 1;

  it("patamar de 24 horas com 2% de ruído, bem acima do resto da série, acusa", () => {
    const series = steady(120, 150).map((v, t) => (t >= 40 && t < 64 ? Math.round(3000 * (1 + 0.02 * wiggle(t))) : v));
    const result = classify(series);
    expect(signal(result, "patamar_liso").fired).toBe(true);
    expect(signal(result, "repeticao_mecanica").fired).toBe(false);
    expect(result.classification).toBe("suspeito");
    expect(result.reason).toContain("variando só");
  });

  it("canal grande e liso a semana inteira não acusa: não há patamar que destoe do resto", () => {
    const series = Array.from({ length: 168 }, (_, t) =>
      Math.round(50_000 * (1 + 0.15 * Math.sin((2 * Math.PI * t) / 24)) * (1 + 0.015 * wiggle(t))),
    );
    const result = classify(series);
    expect(signal(result, "patamar_liso").evaluated).toBe(false);
    expect(result.classification).toBe("legitimo");
  });
});

describe("ritmo dia/noite aprendido da série", () => {
  // Audiência de 200 views/h com noite forte: a hora 0 de cada dia é o meio da tarde, a 12 é o meio da madrugada.
  const day = (t: number) => 1 + 0.8 * Math.cos((2 * Math.PI * t) / 24);
  const audience = Array.from({ length: 168 }, (_, t) => Math.round(200 * day(t)) + ((t * 7) % 9) - 4);
  // Lote de 6 horas com variação de gente (±15%) somado à audiência.
  const inject = (start: number) =>
    audience.map((v, t) => (t >= start && t < start + 6 ? v + Math.round(3000 * (1 + 0.15 * (((t * 37) % 21) / 10 - 1))) : v));

  it("lote ruidoso injetado de madrugada acusa, porque soma queda abrupta com fora do ritmo", () => {
    const result = classify(inject(84));
    expect(signal(result, "fora_do_ritmo").fired).toBe(true);
    expect(result.classification).toBe("suspeito");
    expect(result.reason).toContain("quando o público real não está");
  });

  it("o mesmo lote no horário forte não acusa: sozinha, a queda é formato de live ou destaque", () => {
    const result = classify(inject(72));
    expect(signal(result, "fora_do_ritmo").fired).toBe(false);
    expect(result.classification).toBe("inconclusivo");
  });

  it("sem ciclo dia/noite claro (público em vários fusos), o ritmo nem é avaliado", () => {
    const flat = Array.from({ length: 168 }, (_, t) => 200 + ((t * 37) % 41) - 20);
    const series = flat.map((v, t) => (t >= 84 && t < 90 ? v + 3000 : v));
    expect(signal(classify(series), "fora_do_ritmo").evaluated).toBe(false);
  });
});

describe("todos os picos são julgados", () => {
  it("compra pequena na semana de um viral real acusa, mesmo não sendo o maior pico", () => {
    const viral = withOrganicPeak(steady(168, 100), 30, 6000, 4, 8);
    const series = withBoughtPeak(viral, 130, 1200);
    expect(Math.max(...series)).toBeGreaterThan(series[130]);
    const result = classify(series);
    expect(result.classification).toBe("suspeito");
    const peak = signal(result, "pico_sem_cauda");
    expect(peak.fired).toBe(true);
    expect(peak.detail).toContain("Na hora 130");
    expect(peak.detail).toContain("Não é o maior pico da série");
  });

  it("dois virais reais na mesma série continuam legítimos", () => {
    const series = withOrganicPeak(withOrganicPeak(steady(168, 100), 30, 6000, 4, 8), 120, 2000, 3, 6);
    const result = classify(series);
    expect(result.classification).toBe("legitimo");
    expect(signal(result, "pico_sem_cauda").detail).toContain("Examinei");
  });
});

describe("prefere não acusar", () => {
  it("pico enorme nas últimas horas da série fica inconclusivo: ainda não dá para ver a cauda", () => {
    const series = withBoughtPeak(steady(72, 100), 69, 8000);
    const result = classify(series);
    expect(result.classification).toBe("inconclusivo");
    expect(result.reason).toContain("prefiro não acusar");
    expect(result.reason).toContain("só há 2 horas de série");
    const peak = signal(result, "pico_sem_cauda");
    expect(peak.evaluated).toBe(false);
    expect(peak.fired).toBe(false);
  });

  it("a mesma série com 12 horas a mais, sem cauda, passa a ser suspeita", () => {
    const series = withBoughtPeak(steady(84, 100), 69, 8000);
    expect(classify(series).classification).toBe("suspeito");
  });

  it("viral que esfria rápido (cauda curta, zona cinza) fica inconclusivo em vez de suspeito", () => {
    const series = withOrganicPeak(steady(96, 100), 40, 4900, 1, 0.7);
    const result = classify(series);
    const peak = signal(result, "pico_sem_cauda");
    expect(peak.value!).toBeGreaterThanOrEqual(CALIBRATED.peak_tail);
    expect(peak.value!).toBeLessThan(PARAMS.peak.tailGray);
    expect(result.classification).toBe("inconclusivo");
  });

  it("criador com pouquíssimas views fica inconclusivo", () => {
    const series = steady(96, 3);
    const result = classify(series);
    expect(result.classification).toBe("inconclusivo");
    expect(result.reason).toContain("volume baixo");
  });

  it("série limpa de 30 horas é inconclusiva: cedo demais para afirmar que é legítima", () => {
    const result = classify(steady(30, 100));
    expect(result.classification).toBe("inconclusivo");
    expect(result.reason).toContain("cedo");
  });

  it("série com menos de 24 horas não é examinada", () => {
    const result = classify(steady(10, 100));
    expect(result.classification).toBe("inconclusivo");
    expect(result.signals).toEqual([]);
  });
});

describe("casos óbvios", () => {
  it("audiência com ciclo dia/noite é legítima", () => {
    const result = classify(dailyCycle(168));
    expect(result.classification).toBe("legitimo");
    expect(result.signals.every((s) => !s.fired)).toBe(true);
  });

  it("patamar de exatamente 300 views por hora durante 48 horas é repetição mecânica", () => {
    const series = steady(96, 20).map((v, t) => (t >= 24 && t < 72 ? 300 : v));
    const result = classify(series);
    expect(result.classification).toBe("suspeito");
    const mech = signal(result, "repeticao_mecanica");
    expect(mech.fired).toBe(true);
    expect(mech.value).toBe(0);
    expect(result.reason).toContain("quase sem variar");
  });

  it("patamar regular demais que despenca de uma hora para outra é suspeito", () => {
    // 1.000 views/h variando ±1: regular demais para gente, e depois some.
    const series = steady(96, 40).map((v, t) => (t >= 20 && t < 60 ? 1000 + (t % 3) - 1 : v));
    const result = classify(series);
    expect(result.classification).toBe("suspeito");
    expect(signal(result, "queda_abrupta").fired).toBe(true);
    expect(result.reason).toContain("Na hora 60");
    expect(result.reason).toContain("regular demais para gente");
  });

  it("rajada de 800 views a cada 6 horas é periódica", () => {
    const series = steady(96, 50).map((v, t) => (t % 6 === 2 ? v + 800 : v));
    const result = classify(series);
    expect(result.classification).toBe("suspeito");
    const periodic = signal(result, "rajadas_periodicas");
    expect(periodic.fired).toBe(true);
    expect(periodic.value).toBe(1);
    expect(result.reason).toContain("ficaram a até 1 hora de 6 horas");
  });

  it("decaimento natural depois da publicação é legítimo", () => {
    const series = Array.from({ length: 120 }, (_, t) => Math.round(2000 * Math.exp(-t / 30) + 50 + ((t * 13) % 17)));
    expect(classify(series).classification).toBe("legitimo");
  });
});

describe("queda abrupta isolada", () => {
  it("patamar com variação de gente que some de uma vez fica inconclusivo, não suspeito", () => {
    // Pode ser live que terminou, destaque que acabou ou viral cortado.
    const series = steady(96, 40).map((v, t) => (t >= 20 && t < 60 ? v * 25 : v));
    const result = classify(series);
    expect(signal(result, "queda_abrupta").fired).toBe(true);
    expect(result.signals.filter((s) => s.fired).map((s) => s.name)).toEqual(["queda_abrupta"]);
    expect(result.classification).toBe("inconclusivo");
    expect(result.reason).toContain("Sozinha, uma queda assim também acontece");
  });

  it("queda junto com outro sinal continua suspeita", () => {
    // Rajadas a cada 4 horas durante o patamar e depois corte.
    const series = steady(120, 40).map((v, t) => (t >= 20 && t < 80 ? v * 25 + (t % 4 === 0 ? 5000 : 0) : v));
    const result = classify(series);
    expect(signal(result, "queda_abrupta").fired).toBe(true);
    expect(signal(result, "rajadas_periodicas").fired).toBe(true);
    expect(result.classification).toBe("suspeito");
  });

  it("criador pequeno: queda menor que cinco desvios de Poisson do patamar não é avaliada", () => {
    // Patamar de 36 caindo para 12: queda de 24 views, abaixo de 5 × √36 = 30.
    const series = Array.from({ length: 96 }, (_, t) => (t < 48 ? 36 + (t % 2) : 12 + (t % 2)));
    expect(signal(classify(series), "queda_abrupta").evaluated).toBe(false);
  });
});

describe("ciclo dia/noite forte", () => {
  // Noite perto de zero: views caem de centenas para quase nada todo dia, sempre no mesmo horário.
  const strongNight = (amp: number) =>
    Array.from({ length: 168 }, (_, t) => Math.round(80 * (1 + amp * Math.sin((2 * Math.PI * t) / 24)) + ((t * 7) % 5)));
  const clippedNight = Array.from({ length: 168 }, (_, t) =>
    Math.round(300 * Math.max(0.02, Math.sin((2 * Math.PI * t) / 24)) + ((t * 7) % 5)),
  );

  it.each([0.8, 0.9, 0.95])("ciclo com amplitude %s não vira queda abrupta", (amp) => {
    const result = classify(strongNight(amp));
    expect(signal(result, "queda_abrupta").fired).toBe(false);
    expect(result.classification).not.toBe("suspeito");
  });

  it("noite cortada quase a zero todo dia não vira queda abrupta", () => {
    const result = classify(clippedNight);
    expect(signal(result, "queda_abrupta").fired).toBe(false);
    expect(result.classification).not.toBe("suspeito");
  });

  it("um corte que não se repete no dia seguinte continua sendo queda abrupta", () => {
    const cut = clippedNight.map((v, t) => (t >= 50 && t < 98 ? v + 3000 : v));
    expect(signal(classify(cut), "queda_abrupta").fired).toBe(true);
  });
});

describe("texto do motivo", () => {
  it("linha de base abaixo de 1 aparece como menos de 1 view/h, e 1 no singular", () => {
    const zeros = Array.from({ length: 96 }, (_, t) => (t === 40 ? 500 : 0));
    expect(classify(zeros).reason).toContain("linha de base de menos de 1 view/h");
    const ones = Array.from({ length: 96 }, (_, t) => (t === 40 ? 500 : 1));
    expect(classify(ones).reason).toContain("linha de base de 1 view/h");
  });

  it("suspeito é apresentado como algo que merece revisão, não como fraude comprovada", () => {
    expect(classify(withBoughtPeak(steady(96), 40, 5000)).reason).toMatch(/^Suspeito: padrão que merece revisão humana\./);
  });
});

describe("explicabilidade e determinismo", () => {
  const cases = {
    legitimo: dailyCycle(96),
    suspeito: withBoughtPeak(steady(96), 40, 5000),
    inconclusivo: withBoughtPeak(steady(72), 69, 8000),
  };

  it("todo sinal traz valor medido, limiar e se disparou", () => {
    for (const series of Object.values(cases)) {
      for (const s of classify(series).signals) {
        expect(typeof s.threshold).toBe("number");
        expect(typeof s.fired).toBe("boolean");
        expect(s.value === null || typeof s.value === "number").toBe(true);
        expect(s.detail.length).toBeGreaterThan(20);
      }
    }
  });

  it("o motivo é uma frase em português sem nomes internos do código", () => {
    for (const [label, series] of Object.entries(cases)) {
      const { classification, reason } = classify(series);
      expect(classification).toBe(label);
      expect(reason).not.toMatch(/[a-z]+_[a-z]+/);
      expect(reason).not.toMatch(/\b(null|undefined|NaN|true|false)\b/);
    }
  });

  it("mesma série, mesma resposta", () => {
    for (const series of Object.values(cases)) expect(classify([...series])).toEqual(classify(series));
  });
});
