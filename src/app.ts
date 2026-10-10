import { createHash } from "node:crypto";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError, ZodSchema } from "zod";
import { classify } from "./classifier/classify.ts";
import { criteriaDocument } from "./classifier/criteria.ts";
import { CLASSIFIER_VERSION } from "./classifier/thresholds.ts";
import type { Clock } from "./clock.ts";
import { type Db, findClassification, saveClassification } from "./db.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { classificationParamsSchema, classifyRequestSchema } from "./schemas.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
  /** Padrão: logger silencioso (testes). O servidor passa o de `createLogger`. */
  logger?: Logger;
}

const HOUR_MS = 3_600_000;
/** 2160 pontos ocupam uns 60 KB em JSON; 1 MB dá folga para formatação e campos extras. */
export const MAX_BODY_BYTES = 1024 * 1024;
// Objeto novo a cada resposta: o Response do @hono/node-server guarda o objeto de headers recebido, e
// reaproveitar uma constante quebrava as respostas seguintes ("v is not iterable").
const jsonHeaders = () => ({ "content-type": "application/json; charset=utf-8" });

/** Chave da classificação: mesma versão do critério, mesmo post e mesma série dão a mesma chave. */
export function classificationId(postId: string, publishedAt: string, views: readonly number[]): string {
  return createHash("sha256")
    .update(JSON.stringify([CLASSIFIER_VERSION, postId, publishedAt, views]))
    .digest("hex");
}

interface ErrorDetail {
  path: string;
  message: string;
}

const errorResponse = (status: ContentfulStatusCode, code: string, message: string, details?: ErrorDetail[]) =>
  new Response(JSON.stringify({ error: { code, message, ...(details ? { details } : {}) } }), {
    status,
    headers: jsonHeaders(),
  });

/** points.5.hour vira points[5].hour, que é como o campo aparece no JSON enviado. */
const formatPath = (path: (string | number)[]): string =>
  path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), "");

/**
 * Único ponto que converte erro do zod no formato de erro da API. Série curta ou longa demais ganha código
 * próprio, porque é o erro mais comum de quem integra.
 */
function validationError(error: ZodError): Response {
  const details = error.issues.map((i) => ({ path: formatPath(i.path) || "(corpo)", message: i.message }));
  const first = error.issues[0];
  const isPointsLength = first.path.length === 1 && first.path[0] === "points";
  const code =
    isPointsLength && first.code === "too_small"
      ? "SERIES_TOO_SHORT"
      : isPointsLength && first.code === "too_big"
        ? "SERIES_TOO_LONG"
        : "VALIDATION_ERROR";
  const message = details[0].path === "(corpo)" ? details[0].message : `${details[0].path}: ${details[0].message}`;
  return errorResponse(400, code, message, details);
}

function validate<T extends ZodSchema>(target: "json" | "param", schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) return validationError(result.error as ZodError);
  });
}

export function createApp({ db, clock, logger = silentLogger }: AppDeps): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, classifier_version: CLASSIFIER_VERSION }));
  app.get("/criteria", (c) => c.json(criteriaDocument()));

  app.post(
    "/classify",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: () => errorResponse(413, "PAYLOAD_TOO_LARGE", `O corpo passa do limite de ${MAX_BODY_BYTES} bytes.`),
    }),
    async (c, next) => {
      // O validador do Hono só lê o corpo com Content-Type JSON; sem ele, a recusa precisa ser explícita.
      if (!/^application\/(.+\+)?json\b/i.test(c.req.header("content-type") ?? "")) {
        return errorResponse(415, "UNSUPPORTED_MEDIA_TYPE", "Envie o corpo como JSON, com Content-Type: application/json.");
      }
      await next();
    },
    validate("json", classifyRequestSchema),
    (c) => {
      const { post_id, published_at, views } = c.req.valid("json");

      const now = clock.now();
      const lastHourStart = new Date(Date.parse(published_at) + (views.length - 1) * HOUR_MS);
      if (lastHourStart > now) {
        return errorResponse(
          422,
          "SERIES_IN_FUTURE",
          `A série tem ${views.length} horas a partir de ${published_at}, então a última hora começaria em ` +
            `${lastHourStart.toISOString()}, depois do horário atual (${now.toISOString()}).`,
        );
      }

      const id = classificationId(post_id, published_at, views);
      const existing = findClassification(db, id);
      if (existing) return c.body(existing.response_json, 200, jsonHeaders());

      const result = classify(views);
      const response = {
        id,
        post_id,
        published_at,
        classifier_version: CLASSIFIER_VERSION,
        classification: result.classification,
        reason: result.reason,
        signals: result.signals,
        summary: result.summary,
        classified_at: now.toISOString(),
      };
      const stored = saveClassification(db, {
        id,
        post_id,
        classifier_version: CLASSIFIER_VERSION,
        classification: result.classification,
        request_json: JSON.stringify({ post_id, published_at, views }),
        response_json: JSON.stringify(response),
        created_at: now.toISOString(),
      });
      return c.body(stored.response_json, 200, jsonHeaders());
    },
  );

  app.get("/classifications/:id", validate("param", classificationParamsSchema), (c) => {
    const stored = findClassification(db, c.req.valid("param").id);
    if (!stored) return errorResponse(404, "NOT_FOUND", "Classificação não encontrada.");
    return c.body(stored.response_json, 200, jsonHeaders());
  });

  app.notFound(() => errorResponse(404, "NOT_FOUND", "Rota não encontrada."));
  app.onError((err, c) => {
    // JSON malformado chega aqui como HTTPException 400 do validador do Hono.
    if (err instanceof HTTPException && err.status === 400) {
      return errorResponse(400, "INVALID_JSON", "O corpo da requisição não é um JSON válido.");
    }
    // Detalhe só no log; o cliente recebe uma mensagem genérica, sem stack trace.
    logger.error({ err, method: c.req.method, path: c.req.path }, "erro inesperado");
    return errorResponse(500, "INTERNAL_ERROR", "Erro interno.");
  });
  return app;
}
