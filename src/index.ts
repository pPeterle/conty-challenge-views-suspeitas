import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDb } from "./db.ts";

const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_PATH ?? "classifications.db");
serve({ fetch: createApp({ db, clock: systemClock }).fetch, port }, (info) => {
  console.log(`API ouvindo em http://localhost:${info.port}`);
});
