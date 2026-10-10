import { type Fired, firingPeak } from "./decide.ts";
import { fmtDec, fmtInt, fmtPct, fmtRate, fmtRatio, plural } from "./format.ts";
import type { Measurements } from "./measure.ts";
import { round4 } from "./stats.ts";
import { type FiringThresholds, PARAMS } from "./thresholds.ts";

export type SignalName = keyof Fired;

export interface Signal {
  name: SignalName;
  /** Valor medido. `null` quando o sinal não pôde ser avaliado nesta série. */
  value: number | null;
  threshold: number;
  /** Como o valor é comparado ao limiar para o sinal disparar. */
  fires_when: "below" | "at_or_above";
  evaluated: boolean;
  fired: boolean;
  detail: string;
}

/** Transforma as medidas em sinais com texto legível. Não decide nada: o `fired` vem de decide.ts. */
export function buildSignals(m: Measurements, thr: FiringThresholds, fired: Fired): Signal[] {
  const signals = [
    peakSignal(m, thr, fired.pico_sem_cauda),
    dropSignal(m, thr, fired.queda_abrupta),
    mechanicalSignal(m, thr, fired.repeticao_mecanica),
    periodicSignal(m, thr, fired.rajadas_periodicas),
  ];
  // Ordem fixa dos campos no JSON, para a resposta ler de cima para baixo.
  return signals.map((s) => ({
    name: s.name,
    value: s.value,
    threshold: s.threshold,
    fires_when: s.fires_when,
    evaluated: s.evaluated,
    fired: s.fired,
    detail: s.detail,
  }));
}

function peakSignal(m: Measurements, thr: FiringThresholds, fired: boolean): Signal {
  const t = PARAMS.peak;
  // Quando dispara, descreve o pico que disparou, que pode não ser o maior da série.
  const pk = (fired ? firingPeak(m, thr) : null) ?? m.peak;
  const base = { name: "pico_sem_cauda" as const, threshold: thr.peak_tail, fires_when: "below" as const, fired };
  if (pk.status === "none") {
    return {
      ...base,
      value: null,
      evaluated: false,
      detail:
        `Sem pico relevante: a maior hora (hora ${pk.hour}) teve ${fmtInt(pk.views)} views para uma linha de base ` +
        `de ${fmtRate(m.base)}. Um pico só é examinado quando passa de ${t.minRatioToBase} vezes a base e de ` +
        `${t.minExcess} views acima dela.`,
    };
  }
  const notTheBiggest =
    pk !== m.peak
      ? ` Não é o maior pico da série: o maior, na hora ${m.peak.hour}, teve ${fmtInt(m.peak.views)} views e não ` +
        `tem o formato de lote.`
      : "";
  const examined = 1 + m.otherPeaks.length;
  const peakText =
    `Na hora ${pk.hour} o post teve ${fmtInt(pk.views)} views, ${fmtRatio(pk.ratio)} vezes a linha de base de ` +
    `${fmtRate(pk.base)}${pk === m.peak ? "" : " (o nível logo antes dele)"}, num pico de ` +
    `${plural(pk.width, "hora", "horas")}.${notTheBiggest}` +
    (examined > 1 && pk === m.peak && !fired ? ` Examinei ${examined} picos relevantes; nenhum tem formato de lote.` : "");
  if (pk.status === "unobservable") {
    return {
      ...base,
      value: null,
      evaluated: false,
      detail:
        `${peakText} Depois do pico só há ${plural(pk.hoursAfter, "hora", "horas")} de série; preciso de ` +
        `${t.tailHours} para ver se as views caem de volta (compra) ou decaem aos poucos (viral).`,
    };
  }
  const tailText = `Nas ${t.tailHours} horas seguintes, juntas, vieram ${fmtPct(pk.tail)} das views extras da hora do pico`;
  const riseText =
    pk.rise < t.maxRise
      ? "chegou de uma hora para outra"
      : `teve subida gradual (as ${t.riseHours} horas antes já somavam ${fmtPct(pk.rise)} do excesso do pico)`;
  let detail: string;
  if (fired) {
    detail =
      `${peakText} O pico ${riseText}. ${tailText}: as views voltaram à base logo depois, sem a cauda de ` +
      `decaimento de um vídeo que estoura de verdade. Degrau de até ${t.maxBlockWidth} horas que some sem cauda ` +
      `(abaixo de ${fmtPct(thr.peak_tail)}) é o formato de views entregues em lote.`;
  } else if (pk.tail < t.tailGray) {
    const why =
      pk.width > t.maxBlockWidth
        ? `durou mais de ${t.maxBlockWidth} horas, o que parece mais live ou destaque na plataforma do que lote`
        : pk.rise >= t.maxRise
          ? `${riseText}, como viral real que foi cortado`
          : `a cauda ficou entre ${fmtPct(thr.peak_tail)} e ${fmtPct(t.tailGray)}, como viral que esfriou rápido`;
    detail = `${peakText} ${tailText}. Cauda curta, mas o pico ${why}.`;
  } else {
    detail = `${peakText} ${tailText}: decaimento gradual, como em audiência real.`;
  }
  return { ...base, value: round4(pk.tail), evaluated: true, detail };
}

function dropSignal(m: Measurements, thr: FiringThresholds, fired: boolean): Signal {
  const t = PARAMS.drop;
  const d = m.drop;
  const base = { name: "queda_abrupta" as const, threshold: thr.drop, fires_when: "at_or_above" as const, fired };
  if (d === null) {
    return {
      ...base,
      value: null,
      evaluated: false,
      detail:
        `Não avaliado: nenhum trecho ficou em ${t.minLevelBefore} views/h ou mais por ${t.windowBefore} horas ` +
        `e depois caiu mais de ${t.poissonSigmas} desvios de Poisson; abaixo disso, o ruído normal de contagem ` +
        `já produz quedas grandes.`,
    };
  }
  const detail = fired
    ? `Na hora ${d.hour} as views caíram de ${fmtInt(d.from)} para ${fmtInt(d.to)} de uma hora para outra, ` +
      `depois de um patamar de ${fmtRate(d.before)} nas ${t.windowBefore} horas anteriores, e ficaram em ` +
      `${fmtRate(d.after)}. Queda de ${fmtPct(d.value)} (limiar ${fmtPct(thr.drop)}): audiência humana ` +
      `costuma desacelerar aos poucos, e um corte assim lembra um pacote de views que acabou. ` +
      (d.plateauDispersion < t.regularPlateau
        ? `O patamar antes da queda era regular demais para gente (índice de dispersão ` +
          `${fmtDec(d.plateauDispersion)}, abaixo de ${fmtDec(t.regularPlateau)}).`
        : `O patamar antes da queda variava como audiência real (índice de dispersão ` +
          `${fmtDec(d.plateauDispersion)}).`)
    : `A maior queda sustentada de uma hora para outra foi de ${fmtPct(Math.max(0, d.value))}, na hora ${d.hour} ` +
      `(dispara a partir de ${fmtPct(thr.drop)}).`;
  return { ...base, value: round4(d.value), evaluated: true, detail };
}

function mechanicalSignal(m: Measurements, thr: FiringThresholds, fired: boolean): Signal {
  const t = PARAMS.mechanical;
  const w = m.mechanical;
  const base = {
    name: "repeticao_mecanica" as const,
    threshold: thr.mechanical_dispersion,
    fires_when: "below" as const,
    fired,
  };
  if (w === null) {
    return {
      ...base,
      value: null,
      evaluated: false,
      detail: `Não avaliado: nenhuma janela de ${t.window} horas teve média de ${t.minMean} views/h ou mais.`,
    };
  }
  const end = w.start + t.window - 1;
  const detail = fired
    ? `Entre as horas ${w.start} e ${end} as views ficaram em torno de ${fmtRate(w.mean)} quase sem variar ` +
      `(${w.sample.map(fmtInt).join(", ")}, ...). O índice de dispersão foi ${fmtDec(w.dispersion)}; contagem ` +
      `de pessoas reais oscila pelo menos tanto quanto a média (índice perto de 1 ou acima), e abaixo de ` +
      `${fmtDec(thr.mechanical_dispersion)} é ritmo de máquina.`
    : `A janela de ${t.window} horas mais regular (horas ${w.start} a ${end}) teve índice de dispersão ` +
      `${fmtDec(w.dispersion)}, variação compatível com pessoas (dispara abaixo de ${fmtDec(thr.mechanical_dispersion)}).`;
  return { ...base, value: round4(w.dispersion), evaluated: true, detail };
}

function periodicSignal(m: Measurements, thr: FiringThresholds, fired: boolean): Signal {
  const t = PARAMS.periodic;
  const pr = m.periodic;
  const base = {
    name: "rajadas_periodicas" as const,
    threshold: thr.periodic_fraction,
    fires_when: "at_or_above" as const,
    fired,
  };
  if (pr.period === null || pr.fraction === null) {
    return {
      ...base,
      value: null,
      evaluated: false,
      detail:
        `Não avaliado: ${plural(pr.bursts, "rajada encontrada", "rajadas encontradas")} ` +
        `(hora com ${t.burstRatio} vezes a base local); são necessárias ${t.minBursts} para falar em periodicidade.`,
    };
  }
  const bursts = plural(pr.bursts, "rajada", "rajadas");
  const period = plural(pr.period, "hora", "horas");
  let detail: string;
  if (fired) {
    detail =
      `${bursts} de views, e ${fmtPct(pr.fraction)} dos intervalos entre elas foram de exatamente ${period} ` +
      `(a partir da hora ${pr.firstBurst}). Pessoas não chegam num relógio; entrega agendada chega.`;
  } else if (pr.period < t.minPeriod || pr.period > t.maxPeriod) {
    detail =
      `${bursts}, intervalo mais comum de ${period}. Fora da faixa de ${t.minPeriod} a ${t.maxPeriod} horas ` +
      `(24 horas é o ciclo dia/noite normal).`;
  } else {
    detail =
      `${bursts}, mas só ${fmtPct(pr.fraction)} dos intervalos se repetem (dispara a partir de ` +
      `${fmtPct(thr.periodic_fraction)}): sem relógio fixo.`;
  }
  return { ...base, value: round4(pr.fraction), evaluated: true, detail };
}
