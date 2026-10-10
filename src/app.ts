import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { classify } from "./classifier/classify.ts";
import { CLASSIFIER_VERSION } from "./classifier/thresholds.ts";
import type { Clock } from "./clock.ts";
import { type Db, findClassification, saveClassification } from "./db.ts";
import { parseClassifyRequest } from "./validation.ts";

export interface AppDeps {
  db: Db;
  clock: Clock;
}

const HOUR_MS = 3_600_000;

/** Chave da classificação: mesma versão do critério, mesmo post e mesma série dão a mesma chave. */
export function classificationId(postId: string, publishedAt: string, views: readonly number[]): string {
  return createHash("sha256")
    .update(JSON.stringify([CLASSIFIER_VERSION, postId, publishedAt, views]))
    .digest("hex");
}

export function createApp({ db, clock }: AppDeps): Hono {
  const app = new Hono();
  const error = (status: ContentfulStatusCode, code: string, message: string) =>
    new Response(JSON.stringify({ error: { code, message } }), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

  app.get("/health", (c) => c.json({ ok: true, classifier_version: CLASSIFIER_VERSION }));

  app.post("/classify", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return error(400, "INVALID_JSON", "O corpo da requisição não é um JSON válido.");
    }
    const parsed = parseClassifyRequest(body);
    if (!parsed.ok) return error(400, parsed.code, parsed.message);
    const { post_id, published_at, views } = parsed.value;

    const now = clock.now();
    const lastHourStart = new Date(Date.parse(published_at) + (views.length - 1) * HOUR_MS);
    if (lastHourStart > now) {
      return error(
        422,
        "SERIES_IN_FUTURE",
        `A série tem ${views.length} horas a partir de ${published_at}, então a última hora começaria em ` +
          `${lastHourStart.toISOString()}, depois do horário atual (${now.toISOString()}).`,
      );
    }

    const id = classificationId(post_id, published_at, views);
    const existing = findClassification(db, id);
    if (existing) return c.body(existing.response_json, 200, { "content-type": "application/json; charset=utf-8" });

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
    return c.body(stored.response_json, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.get("/classifications/:id", (c) => {
    const stored = findClassification(db, c.req.param("id"));
    if (!stored) return error(404, "NOT_FOUND", "Classificação não encontrada.");
    return c.body(stored.response_json, 200, { "content-type": "application/json; charset=utf-8" });
  });

  app.notFound(() => error(404, "NOT_FOUND", "Rota não encontrada."));
  app.onError((err) => {
    console.error(err);
    return error(500, "INTERNAL_ERROR", "Erro interno.");
  });
  return app;
}
