import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { systemClock } from "./clock.ts";
import { openDb } from "./db.ts";
import { createLogger, flushOnShutdown } from "./logger.ts";

const logger = createLogger();
const port = Number(process.env.PORT ?? 3000);
const db = openDb(process.env.DB_PATH ?? "classifications.db");
const server = serve({ fetch: createApp({ db, clock: systemClock, logger }).fetch, port }, (info) => {
  logger.info({ port: info.port }, `API ouvindo em http://localhost:${info.port}`);
});
flushOnShutdown(logger, () => server.close());
