import { PARAMS } from "./classifier/thresholds.ts";

export const MAX_HOURS = 24 * 90;

export interface ClassifyRequest {
  post_id: string;
  published_at: string;
  views: number[];
}

export type ValidationResult =
  | { ok: true; value: ClassifyRequest }
  | { ok: false; code: "VALIDATION_ERROR" | "SERIES_TOO_SHORT" | "SERIES_TOO_LONG"; message: string };

const fail = (code: Extract<ValidationResult, { ok: false }>["code"], message: string): ValidationResult => ({
  ok: false,
  code,
  message,
});

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseClassifyRequest(body: unknown): ValidationResult {
  if (!isObject(body)) return fail("VALIDATION_ERROR", "O corpo precisa ser um objeto JSON.");
  const { post_id, published_at, points } = body;
  if (typeof post_id !== "string" || post_id.trim() === "" || post_id.length > 200) {
    return fail("VALIDATION_ERROR", "post_id é obrigatório: texto de 1 a 200 caracteres.");
  }
  if (typeof published_at !== "string" || Number.isNaN(Date.parse(published_at))) {
    return fail("VALIDATION_ERROR", "published_at é obrigatório: data ISO 8601, ex. 2026-10-01T12:00:00Z.");
  }
  if (!Array.isArray(points)) {
    return fail("VALIDATION_ERROR", "points é obrigatório: lista de { hour, views } com as views ganhas em cada hora.");
  }
  if (points.length < PARAMS.minHours) {
    return fail(
      "SERIES_TOO_SHORT",
      `A série tem ${points.length} horas; são necessárias pelo menos ${PARAMS.minHours} para classificar.`,
    );
  }
  if (points.length > MAX_HOURS) {
    return fail("SERIES_TOO_LONG", `A série tem ${points.length} horas; o máximo aceito é ${MAX_HOURS} (90 dias).`);
  }
  const views: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (!isObject(point)) return fail("VALIDATION_ERROR", `points[${i}] precisa ser um objeto { hour, views }.`);
    if (point.hour !== i) {
      return fail(
        "VALIDATION_ERROR",
        `points[${i}].hour deveria ser ${i}: as horas contam a partir de 0 desde a publicação, em ordem e sem ` +
          `buracos (veio ${JSON.stringify(point.hour)}).`,
      );
    }
    if (typeof point.views !== "number" || !Number.isInteger(point.views) || point.views < 0) {
      return fail(
        "VALIDATION_ERROR",
        `points[${i}].views precisa ser inteiro maior ou igual a zero: as views ganhas naquela hora, não o ` +
          `acumulado (veio ${JSON.stringify(point.views)}).`,
      );
    }
    views.push(point.views);
  }
  return { ok: true, value: { post_id, published_at: new Date(published_at).toISOString(), views } };
}
