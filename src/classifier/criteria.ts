import calibration from "./thresholds.json" with { type: "json" };
import { CALIBRATED, CLASSIFIER_VERSION, PARAMS } from "./thresholds.ts";

/**
 * O que o critério não detecta, em versão curta. Os títulos são os mesmos da seção "O que o critério NÃO
 * detecta" de docs/criterio.md (um teste confere), que traz a explicação longa.
 */
export const NOT_DETECTED: Array<{ title: string; summary: string }> = [
  { title: "Bots que imitam curva orgânica", summary: "Compra com subida gradual, decaimento exponencial e ruído realista passa por todos os sinais." },
  { title: "Compra gradual diluída", summary: "Views falsas somadas aos poucos ao longo de dias não mudam a forma da curva." },
  { title: "Patamar com ruído", summary: "Robô com variação na escala de uma Poisson, ou somado a muita audiência real, escapa de repeticao_mecanica." },
  { title: "Rajadas com intervalo irregular", summary: "Rajadas sem relógio fixo, a cada 24 horas ou a cada 2 horas não disparam rajadas_periodicas." },
  { title: "Live curta", summary: "Live de 2 ou 3 horas que começa e termina de uma vez tem o formato de lote comprado e vira suspeito." },
  { title: "Queda abrupta de patamar com ruído de gente", summary: "Sozinha dá inconclusivo; robô com patamar realista que para de uma vez não é acusado." },
  { title: "Pico comprado no fim da série", summary: "Fica inconclusivo até haver 10 horas depois do pico." },
  { title: "Compra pequena perto do nível do momento", summary: "Pico secundário só conta acima de 5 vezes o nível logo antes dele; lote pequeno na cauda de um viral passa." },
  { title: "Contas pequenas", summary: "Volume muito baixo dá inconclusivo; ruído alto ainda gera alguns falsos positivos por pico_sem_cauda." },
  { title: "Causas legítimas de queda abrupta", summary: "Post apagado, privado ou retirado de recomendação também cai de uma vez; suspeito quer dizer revisão humana." },
  { title: "Corte que coincide com a noite", summary: "Queda que se repete no mesmo horário do dia anterior ou seguinte é ignorada, mesmo se for robô." },
  { title: "Ausência de ciclo dia/noite", summary: "Não é usada como sinal: depende do fuso da audiência." },
];

/** Documento servido por GET /criteria: limiares e parâmetros vêm dos mesmos objetos que o classificador usa. */
export function criteriaDocument() {
  return {
    classifier_version: CLASSIFIER_VERSION,
    thresholds: CALIBRATED,
    calibration: {
      rule: calibration.rule,
      target_fpr: calibration.target_fpr,
      target_met: calibration.target_met,
      seed: calibration.seed,
      false_positive_rate: calibration.calibration.false_positive_rate,
      recall: calibration.calibration.recall,
    },
    params: PARAMS,
    signals: [
      { name: "pico_sem_cauda", fires_when: "below", threshold: CALIBRATED.peak_tail, measures: "fração das views extras do pico que ainda aparece nas 10 horas depois dele, em pico de até 3 horas que chega de uma vez; vale para qualquer pico relevante, não só o maior" },
      { name: "queda_abrupta", fires_when: "at_or_above", threshold: CALIBRATED.drop, measures: "maior queda de uma hora para outra que se sustenta, fora a que se repete no mesmo horário do dia vizinho" },
      { name: "repeticao_mecanica", fires_when: "below", threshold: CALIBRATED.mechanical_dispersion, measures: "menor índice de dispersão (variância / média) em janelas de 12 horas" },
      { name: "rajadas_periodicas", fires_when: "at_or_above", threshold: CALIBRATED.periodic_fraction, measures: "fração dos intervalos entre rajadas exatamente iguais, com intervalo de 2 a 12 horas" },
    ],
    rules: [
      "Algum sinal disparou: suspeito, exceto queda_abrupta sozinha com patamar de variação humana, que dá inconclusivo.",
      "Pico relevante na zona cinza ou com cauda não observável: inconclusivo.",
      "Mediana abaixo de 5 views/h e nenhuma hora com 100 views ou mais: inconclusivo.",
      "Série com menos de 48 horas: inconclusivo.",
      "Caso contrário: legitimo.",
    ],
    not_detected: NOT_DETECTED,
    documentation: "docs/criterio.md",
  };
}
