import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.ts";
import { readFileSync } from "node:fs";
import { CALIBRATED, CLASSIFIER_VERSION, PARAMS } from "../../src/classifier/thresholds.ts";
import { FixedClock } from "../../src/clock.ts";
import { listClassifications, openDb, type Db } from "../../src/db.ts";
import { steady, withBoughtPeak, withOrganicPeak } from "../series.ts";

const PUBLISHED = "2026-10-01T00:00:00.000Z";
const NOW = "2026-10-10T12:00:00.000Z";

const body = (views: number[], postId = "post-1", publishedAt = PUBLISHED) => ({
  post_id: postId,
  published_at: publishedAt,
  points: views.map((v, hour) => ({ hour, views: v })),
});

let db: Db;
let clock: FixedClock;
let app: ReturnType<typeof createApp>;

const post = (payload: unknown) =>
  app.request("/classify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });

beforeEach(() => {
  db = openDb(":memory:");
  clock = new FixedClock(NOW);
  app = createApp({ db, clock });
});

describe("POST /classify", () => {
  it("devolve classificação, motivo legível e os sinais com valor, limiar e se disparou", async () => {
    const res = await post(body(withBoughtPeak(steady(96), 40, 5000)));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.classification).toBe("suspeito");
    expect(json.reason).toMatch(/^Suspeito: /);
    expect(json.signals.map((s: { name: string }) => s.name)).toEqual([
      "pico_sem_cauda",
      "queda_abrupta",
      "repeticao_mecanica",
      "patamar_liso",
      "fora_do_ritmo",
      "rajadas_periodicas",
    ]);
    const peak = json.signals[0];
    expect(peak).toMatchObject({ fired: true, evaluated: true, threshold: CALIBRATED.peak_tail, fires_when: "below" });
    expect(typeof peak.value).toBe("number");
    expect(json.summary).toMatchObject({ hours: 96, peak_hour: 40 });
    expect(json.classified_at).toBe(NOW);
    expect(json.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pico orgânico e pico comprado de mesma altura recebem classificações diferentes pela API", async () => {
    const base = steady(96);
    const organic = withOrganicPeak(base, 40, 4900);
    const bought = withBoughtPeak(base, 40, organic[40] - base[40]);
    const a = await (await post(body(organic, "organico"))).json();
    const b = await (await post(body(bought, "comprado"))).json();
    expect(a.summary.peak_views).toBe(b.summary.peak_views);
    expect(a.classification).toBe("legitimo");
    expect(b.classification).toBe("suspeito");
  });

  it("pico no fim da série volta inconclusivo e o motivo diz o que falta observar", async () => {
    const json = await (await post(body(withBoughtPeak(steady(72), 69, 8000)))).json();
    expect(json.classification).toBe("inconclusivo");
    expect(json.reason).toContain("prefiro não acusar");
  });

  it("mesma série enviada de novo devolve exatamente a mesma resposta, mesmo com o relógio andando", async () => {
    const payload = body(withBoughtPeak(steady(96), 40, 5000));
    const first = await (await post(payload)).text();
    clock.set("2026-10-11T00:00:00.000Z");
    const second = await (await post(payload)).text();
    expect(second).toBe(first);
    expect(listClassifications(db)).toHaveLength(1);
  });

  it("50 envios concorrentes da mesma série geram uma única classificação gravada e respostas idênticas", async () => {
    const payload = body(withOrganicPeak(steady(120), 50, 3000));
    const responses = await Promise.all(Array.from({ length: 50 }, () => post(payload)));
    const texts = await Promise.all(responses.map((r) => r.text()));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(new Set(texts).size).toBe(1);
    expect(listClassifications(db)).toHaveLength(1);
  });

  it("séries diferentes enviadas em paralelo ficam cada uma com sua classificação", async () => {
    const payloads = Array.from({ length: 20 }, (_, i) => body(withBoughtPeak(steady(96), 30 + i, 5000), `p${i}`));
    const results = await Promise.all([...payloads, ...payloads].map(async (p) => (await post(p)).json()));
    expect(new Set(results.map((r) => r.id)).size).toBe(20);
    expect(results.every((r) => r.classification === "suspeito")).toBe(true);
    expect(listClassifications(db)).toHaveLength(20);
  });

  it("GET /classifications/:id devolve a classificação gravada, 404 quando não existe e 400 com id malformado", async () => {
    const created = await (await post(body(steady(96)))).text();
    const { id } = JSON.parse(created);
    const res = await app.request(`/classifications/${id}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(created);
    const missing = await app.request(`/classifications/${"0".repeat(64)}`);
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
    const malformed = await app.request("/classifications/nao-existe");
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("VALIDATION_ERROR");
  });
});

describe("validação da série", () => {
  const cases: Array<[string, unknown, number, string, RegExp]> = [
    ["JSON inválido", "{", 400, "INVALID_JSON", /JSON válido/],
    ["série curta demais (10 horas)", body(steady(10)), 400, "SERIES_TOO_SHORT", /pelo menos 24/],
    ["série longa demais", body(steady(2161)), 400, "SERIES_TOO_LONG", /90 dias/],
    ["sem post_id", { ...body(steady(48)), post_id: "" }, 400, "VALIDATION_ERROR", /post_id/],
    ["published_at inválido", { ...body(steady(48)), published_at: "ontem" }, 400, "VALIDATION_ERROR", /ISO 8601/],
    ["points ausente", { post_id: "x", published_at: PUBLISHED }, 400, "VALIDATION_ERROR", /points/],
    [
      "hora faltando",
      { ...body(steady(48)), points: body(steady(48)).points.filter((p) => p.hour !== 5) },
      400,
      "VALIDATION_ERROR",
      /points\[5\]\.hour: deveria ser 5/,
    ],
    [
      "views negativas",
      { ...body(steady(48)), points: body(steady(48)).points.map((p) => (p.hour === 3 ? { ...p, views: -1 } : p)) },
      400,
      "VALIDATION_ERROR",
      /points\[3\]\.views/,
    ],
    [
      "views fracionárias",
      { ...body(steady(48)), points: body(steady(48)).points.map((p) => (p.hour === 7 ? { ...p, views: 1.5 } : p)) },
      400,
      "VALIDATION_ERROR",
      /não o acumulado/,
    ],
    [
      "série que termina no futuro",
      body(steady(48), "p", "2026-10-09T13:00:00.000Z"),
      422,
      "SERIES_IN_FUTURE",
      /depois do horário atual/,
    ],
  ];

  it.each(cases)("%s é recusada com erro claro", async (_name, payload, status, code, message) => {
    const res = await post(payload);
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.error.code).toBe(code);
    expect(json.error.message).toMatch(message);
    expect(listClassifications(db)).toHaveLength(0);
  });

  it("série que termina exatamente agora é aceita", async () => {
    const res = await post(body(steady(48), "p", "2026-10-08T13:00:00.000Z"));
    expect(res.status).toBe(200);
  });

  it.each([
    ["+14:00", "2026-09-30T10:00:00.000Z"],
    ["-12:00", "2026-10-01T12:00:00.000Z"],
    ["+05:45", "2026-09-30T18:15:00.000Z"],
  ])("published_at com fuso %s existe e volta normalizado para UTC", async (offset, utc) => {
    const res = await post(body(steady(48), "p", `2026-10-01T00:00:00${offset}`));
    expect(res.status).toBe(200);
    expect((await res.json()).published_at).toBe(utc);
  });
});

describe("servidor HTTP real", () => {
  it("responde 200 a séries diferentes em sequência e repete a resposta da primeira", async () => {
    const server = serve({ fetch: createApp({ db: openDb(":memory:"), clock: new FixedClock(NOW) }).fetch, port: 0 });
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as AddressInfo;
    const send = (payload: unknown) =>
      fetch(`http://127.0.0.1:${port}/classify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    try {
      const first = await send(body(steady(96), "a"));
      const second = await send(body(withBoughtPeak(steady(96), 40, 5000), "b"));
      const again = await send(body(steady(96), "a"));
      expect([first.status, second.status, again.status]).toEqual([200, 200, 200]);
      const [t1, , t3] = await Promise.all([first.text(), second.text(), again.text()]);
      expect(t3).toBe(t1);
    } finally {
      server.close();
    }
  });
});

describe("GET /criteria", () => {
  it("devolve versão, limiares calibrados e o que o critério não detecta", async () => {
    const res = await app.request("/criteria");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.classifier_version).toBe(CLASSIFIER_VERSION);
    expect(json.thresholds).toEqual(CALIBRATED);
    expect(json.signals.map((s: { threshold: number }) => s.threshold)).toEqual([
      CALIBRATED.peak_tail,
      CALIBRATED.drop,
      CALIBRATED.mechanical_dispersion,
      PARAMS.smooth.maxCv,
      PARAMS.rhythm.maxEventLevel,
      CALIBRATED.periodic_fraction,
    ]);
    expect(json.not_detected.length).toBeGreaterThan(5);
  });

  it("a lista do que não detecta tem os mesmos itens de docs/criterio.md", async () => {
    const doc = readFileSync(new URL("../../docs/criterio.md", import.meta.url), "utf8");
    const section = doc.slice(doc.indexOf("## O que o critério NÃO detecta"), doc.indexOf("## Dataset sintético"));
    const docTitles = [...section.matchAll(/^- \*\*([^*]+?)\.?\*\*/gm)].map((m) => m[1].replace(/\.$/, ""));
    const { not_detected } = await (await app.request("/criteria")).json();
    expect(not_detected.map((n: { title: string }) => n.title)).toEqual(docTitles);
  });
});

describe("modo acumulado", () => {
  it("série acumulada vira incremental e recebe a mesma classificação e o mesmo id da incremental", async () => {
    const views = withBoughtPeak(steady(96), 40, 5000);
    let total = 0;
    const cumulative = views.map((v) => (total += v));
    const inc = await (await post(body(views))).json();
    const cum = await (
      await post({ ...body(cumulative), mode: "cumulative" })
    ).json();
    expect(cum.classification).toBe("suspeito");
    expect(cum.id).toBe(inc.id);
    expect(cum.summary).toEqual(inc.summary);
    expect(listClassifications(db)).toHaveLength(1);
  });

  it("série acumulada que diminui é recusada com o ponto exato", async () => {
    const res = await post({ ...body(steady(48).map((v, i) => 1000 + i - (i === 7 ? 50 : 0))), mode: "cumulative" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/points\[7\]\.views: série acumulada não pode diminuir/);
  });
});
