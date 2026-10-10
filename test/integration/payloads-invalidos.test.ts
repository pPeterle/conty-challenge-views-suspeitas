import { beforeEach, describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, createApp } from "../../src/app.ts";
import { FixedClock } from "../../src/clock.ts";
import { listClassifications, openDb, type Db } from "../../src/db.ts";
import { steady } from "../series.ts";

const NOW = "2026-10-10T12:00:00.000Z";
const JSON_CT = { "content-type": "application/json" };

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = openDb(":memory:");
  app = createApp({ db, clock: new FixedClock(NOW) });
});

const points = (n = 48) => steady(n).map((views, hour) => ({ hour, views }));
const valid = () => ({ post_id: "p1", published_at: "2026-10-01T00:00:00Z", points: points() });
const withPoint = (i: number, patch: Record<string, unknown>) => {
  const body = valid();
  body.points[i] = { ...body.points[i], ...patch } as (typeof body.points)[number];
  return JSON.stringify(body);
};
const json = (patch: Record<string, unknown>) => JSON.stringify({ ...valid(), ...patch });
const raw = (body: string, headers: Record<string, string> = JSON_CT, method = "POST", path = "/classify") =>
  app.request(path, { method, headers, body });

// [descrição, corpo cru, status esperado, código esperado]
const bodyCases: Array<[string, string, number, string]> = [
  ["JSON malformado", "{", 400, "INVALID_JSON"],
  ["corpo vazio", "", 400, "INVALID_JSON"],
  ["NaN literal (não é JSON)", '{"post_id":"p","views":NaN}', 400, "INVALID_JSON"],
  ["null", "null", 400, "VALIDATION_ERROR"],
  ["array no lugar de objeto", "[]", 400, "VALIDATION_ERROR"],
  ["string solta", '"texto"', 400, "VALIDATION_ERROR"],
  ["número solto", "42", 400, "VALIDATION_ERROR"],
  ["post_id ausente", json({ post_id: undefined }), 400, "VALIDATION_ERROR"],
  ["post_id número", json({ post_id: 123 }), 400, "VALIDATION_ERROR"],
  ["post_id vazio", json({ post_id: "" }), 400, "VALIDATION_ERROR"],
  ["post_id só espaços", json({ post_id: "    " }), 400, "VALIDATION_ERROR"],
  ["post_id longo demais", json({ post_id: "x".repeat(201) }), 400, "VALIDATION_ERROR"],
  ["published_at ausente", json({ published_at: undefined }), 400, "VALIDATION_ERROR"],
  ["published_at número", json({ published_at: 1 }), 400, "VALIDATION_ERROR"],
  ['published_at "1"', json({ published_at: "1" }), 400, "VALIDATION_ERROR"],
  ['published_at "Sep 1 2026"', json({ published_at: "Sep 1 2026" }), 400, "VALIDATION_ERROR"],
  ["published_at 30 de fevereiro", json({ published_at: "2026-02-30T00:00:00Z" }), 400, "VALIDATION_ERROR"],
  ["published_at sem fuso", json({ published_at: "2026-10-01T00:00:00" }), 400, "VALIDATION_ERROR"],
  ["published_at só data", json({ published_at: "2026-10-01" }), 400, "VALIDATION_ERROR"],
  ["published_at fuso impossível", json({ published_at: "2026-10-01T00:00:00+25:00" }), 400, "VALIDATION_ERROR"],
  ["points ausente", json({ points: undefined }), 400, "VALIDATION_ERROR"],
  ["points objeto", json({ points: { 0: 1 } }), 400, "VALIDATION_ERROR"],
  ["points string", json({ points: "1,2,3" }), 400, "VALIDATION_ERROR"],
  ["points vazio", json({ points: [] }), 400, "SERIES_TOO_SHORT"],
  ["série de 23 horas", json({ points: points(23) }), 400, "SERIES_TOO_SHORT"],
  ["série de 2161 horas", json({ points: points(2161) }), 400, "SERIES_TOO_LONG"],
  ["ponto null", json({ points: [null, ...points().slice(1)] }), 400, "VALIDATION_ERROR"],
  ["ponto número", json({ points: [5, ...points().slice(1)] }), 400, "VALIDATION_ERROR"],
  ["hour como texto", withPoint(0, { hour: "0" }), 400, "VALIDATION_ERROR"],
  ["hour negativa", withPoint(0, { hour: -1 }), 400, "VALIDATION_ERROR"],
  ["hour fracionária", withPoint(1, { hour: 1.5 }), 400, "VALIDATION_ERROR"],
  ["hour duplicada", withPoint(3, { hour: 2 }), 400, "VALIDATION_ERROR"],
  ["hour fora de ordem", withPoint(3, { hour: 4 }), 400, "VALIDATION_ERROR"],
  ["views ausente", withPoint(2, { views: undefined }), 400, "VALIDATION_ERROR"],
  ["views negativa", withPoint(2, { views: -1 }), 400, "VALIDATION_ERROR"],
  ["views fracionária", withPoint(2, { views: 1.5 }), 400, "VALIDATION_ERROR"],
  ["views como texto", withPoint(2, { views: "10" }), 400, "VALIDATION_ERROR"],
  ["views null", withPoint(2, { views: null }), 400, "VALIDATION_ERROR"],
  ["views acima do teto", withPoint(2, { views: 1_000_000_001 }), 400, "VALIDATION_ERROR"],
  ["views acima do inteiro seguro", withPoint(2, { views: 2 ** 53 + 2 }), 400, "VALIDATION_ERROR"],
  ["views 1e308", withPoint(2, { views: 1e308 }), 400, "VALIDATION_ERROR"],
  ["views 1e999 (vira Infinity)", JSON.stringify(valid()).replace('"views":', '"views":1e999,"x":'), 400, "VALIDATION_ERROR"],
];

describe("payloads inválidos em POST /classify", () => {
  it.each(bodyCases)("%s: recusado com erro no formato padrão", async (_name, body, status, code) => {
    const res = await raw(body);
    expect(res.status).toBe(status);
    expect(res.headers.get("content-type")).toContain("application/json");
    const payload = await res.json();
    expect(payload.error.code).toBe(code);
    expect(typeof payload.error.message).toBe("string");
    expect(payload.error.message.length).toBeGreaterThan(10);
    expect(JSON.stringify(payload)).not.toMatch(/at .*\.ts:\d+|ZodError|stack/);
  });

  it("erros de validação trazem details com caminho e motivo de cada campo", async () => {
    const res = await raw(json({ post_id: "", published_at: "ontem" }));
    const { error } = await res.json();
    expect(error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "post_id" }),
        expect.objectContaining({ path: "published_at" }),
      ]),
    );
  });

  it("nenhum payload inválido grava nada no banco", async () => {
    for (const [, body] of bodyCases) await raw(body);
    expect(listClassifications(db)).toHaveLength(0);
  });

  it("Content-Type ausente ou errado é recusado com 415", async () => {
    const variants: Record<string, string>[] = [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" }];
    for (const headers of variants) {
      const res = await raw(JSON.stringify(valid()), headers);
      expect(res.status).toBe(415);
      expect((await res.json()).error.code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect(listClassifications(db)).toHaveLength(0);
  });

  it("corpo acima de 1 MB é recusado com 413", async () => {
    const big = JSON.stringify({ ...valid(), padding: "x".repeat(MAX_BODY_BYTES) });
    const res = await raw(big);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
    expect(listClassifications(db)).toHaveLength(0);
  });

  it("campos extras são ignorados e post_id com unicode e espaços nas pontas é aceito e aparado", async () => {
    const body = { ...valid(), post_id: "  vídeo 🎬 nº 1  ", extra: { a: 1 }, points: valid().points.map((p) => ({ ...p, x: 1 })) };
    const res = await raw(JSON.stringify(body));
    expect(res.status).toBe(200);
    expect((await res.json()).post_id).toBe("vídeo 🎬 nº 1");
    const [row] = listClassifications(db);
    expect(JSON.parse(row.request_json)).not.toHaveProperty("extra");
  });

  it("published_at com fuso é normalizado para UTC", async () => {
    const res = await raw(json({ published_at: "2026-10-01T09:00:00-03:00" }));
    expect((await res.json()).published_at).toBe("2026-10-01T12:00:00.000Z");
  });

  it("série com o máximo de 2160 horas é aceita", async () => {
    const res = await raw(json({ published_at: "2026-01-01T00:00:00Z", points: points(2160) }));
    expect(res.status).toBe(200);
  });
});

describe("rotas, métodos e erro interno", () => {
  it.each([
    ["GET", "/classify"],
    ["PUT", "/classify"],
    ["DELETE", `/classifications/${"0".repeat(64)}`],
    ["GET", "/nao-existe"],
  ])("%s %s responde 404 em JSON", async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("erro inesperado vira 500 genérico, sem stack trace", async () => {
    db.close();
    const original = console.error;
    console.error = () => {};
    try {
      const res = await raw(JSON.stringify(valid()));
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: { code: "INTERNAL_ERROR", message: "Erro interno." } });
    } finally {
      console.error = original;
    }
  });
});
