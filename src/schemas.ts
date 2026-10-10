import { z } from "zod";
import { PARAMS } from "./classifier/thresholds.ts";

export const MAX_HOURS = 24 * 90;
/** Acima disso por hora não é série plausível de um post; também evita somas que estouram a precisão do double. */
export const MAX_VIEWS_PER_HOUR = 1_000_000_000;

const ISO_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/**
 * Aceita só data e hora ISO 8601 completas com fuso explícito (Z ou ±hh:mm). Sem fuso, a hora 0 da série
 * dependeria do fuso do servidor. Confere ida e volta: 2026-02-30 não vira 2 de março.
 */
export function parseIsoWithOffset(value: string): Date | null {
  const m = ISO_WITH_OFFSET.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, sec = "0"] = m.slice(1, 7).map((v) => v ?? "0");
  const frac = m[7] ? Number(`0.${m[7]}`) * 1000 : 0;
  const local = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), frac);
  const check = new Date(local);
  const roundTrips =
    check.getUTCFullYear() === Number(y) &&
    check.getUTCMonth() === Number(mo) - 1 &&
    check.getUTCDate() === Number(d) &&
    check.getUTCHours() === Number(h) &&
    check.getUTCMinutes() === Number(mi) &&
    check.getUTCSeconds() === Number(sec);
  if (!roundTrips) return null;
  if (m[8] === "Z") return check;
  const offsetH = Number(m[10]);
  const offsetM = Number(m[11]);
  if (offsetH > 14 || offsetM > 59) return null;
  const sign = m[9] === "+" ? 1 : -1;
  return new Date(local - sign * (offsetH * 60 + offsetM) * 60_000);
}

const pointSchema = z
  .object({
    hour: z.number({ message: "precisa ser número inteiro" }).int("precisa ser inteiro").nonnegative("não pode ser negativa"),
    views: z
      .number({ message: "precisa ser número inteiro (as views ganhas naquela hora, não o acumulado)" })
      .int("precisa ser inteiro: as views ganhas naquela hora, não o acumulado")
      .safe(`precisa ser inteiro entre 0 e ${MAX_VIEWS_PER_HOUR}`)
      .nonnegative("não pode ser negativa: são as views ganhas naquela hora, não o acumulado")
      .max(MAX_VIEWS_PER_HOUR, `precisa ser inteiro entre 0 e ${MAX_VIEWS_PER_HOUR}`),
  }, { message: "cada ponto precisa ser um objeto { hour, views }" })
  .strip();

/**
 * Corpo de POST /classify. Campos extras são ignorados (strip). As horas precisam ser 0, 1, 2, ... sem
 * repetição nem buraco, para cada posição do array ser a hora desde a publicação.
 */
export const classifyRequestSchema = z
  .object(
    {
      post_id: z
        .string({ message: "é obrigatório: texto de 1 a 200 caracteres" })
        .trim()
        .min(1, "é obrigatório: texto de 1 a 200 caracteres")
        .max(200, "é obrigatório: texto de 1 a 200 caracteres"),
      published_at: z
        .string({ message: "é obrigatório: data e hora ISO 8601 com fuso, ex. 2026-10-01T12:00:00Z" })
        .trim()
        .refine((v) => parseIsoWithOffset(v) !== null, {
          message:
            "precisa ser data e hora ISO 8601 existente com fuso, ex. 2026-10-01T12:00:00Z ou 2026-10-01T09:00:00-03:00",
        })
        .transform((v) => parseIsoWithOffset(v)!.toISOString()),
      points: z
        .array(pointSchema, { message: "é obrigatório: lista de { hour, views } com as views ganhas em cada hora" })
        .min(PARAMS.minHours, `precisa ter pelo menos ${PARAMS.minHours} horas para classificar`)
        .max(MAX_HOURS, `aceita no máximo ${MAX_HOURS} horas (90 dias)`)
        .superRefine((points, ctx) => {
          const seen = new Set<number>();
          for (let i = 0; i < points.length; i++) {
            const { hour } = points[i];
            if (seen.has(hour)) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, "hour"], message: `hora ${hour} repetida` });
              return;
            }
            seen.add(hour);
            if (hour !== i) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [i, "hour"],
                message: `deveria ser ${i}, porque as horas contam a partir de 0 desde a publicação, em ordem e sem buracos (veio ${hour})`,
              });
              return;
            }
          }
        }),
      mode: z
        .enum(["incremental", "cumulative"], {
          message: 'precisa ser "incremental" (views ganhas em cada hora) ou "cumulative" (total acumulado)',
        })
        .default("incremental"),
    },
    { message: "o corpo precisa ser um objeto JSON" },
  )
  .strip()
  .superRefine((body, ctx) => {
    if (body.mode !== "cumulative") return;
    for (let i = 1; i < body.points.length; i++) {
      if (body.points[i].views < body.points[i - 1].views) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["points", i, "views"],
          message: `série acumulada não pode diminuir: veio ${body.points[i].views} depois de ${body.points[i - 1].views}`,
        });
        return;
      }
    }
  })
  // Daqui para frente só existe série incremental: o acumulado vira a diferença entre horas vizinhas.
  .transform(({ post_id, published_at, mode, points }) => ({
    post_id,
    published_at,
    views: points.map((p, i) => (mode === "cumulative" && i > 0 ? p.views - points[i - 1].views : p.views)),
  }));

export type ClassifyRequest = z.infer<typeof classifyRequestSchema>;

export const classificationParamsSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/, "precisa ser o sha256 (64 caracteres hexadecimais) devolvido por POST /classify"),
});
