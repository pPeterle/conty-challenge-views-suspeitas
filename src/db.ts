import { DatabaseSync } from "node:sqlite";

export interface StoredClassification {
  id: string;
  post_id: string;
  classifier_version: string;
  classification: string;
  request_json: string;
  response_json: string;
  created_at: string;
}

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS classifications (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      classifier_version TEXT NOT NULL,
      classification TEXT NOT NULL,
      request_json TEXT NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS classifications_post ON classifications (post_id, created_at);
  `);
  return db;
}

export function findClassification(db: Db, id: string): StoredClassification | undefined {
  return db.prepare("SELECT * FROM classifications WHERE id = ?").get(id) as StoredClassification | undefined;
}

/**
 * Grava se ainda não existe e devolve o que ficou no banco. Com a mesma chave, a primeira gravação vence:
 * repetições (inclusive concorrentes) recebem exatamente a mesma resposta, com o mesmo `classified_at`.
 */
export function saveClassification(db: Db, row: StoredClassification): StoredClassification {
  db.prepare(
    `INSERT INTO classifications (id, post_id, classifier_version, classification, request_json, response_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    row.id,
    row.post_id,
    row.classifier_version,
    row.classification,
    row.request_json,
    row.response_json,
    row.created_at,
  );
  return findClassification(db, row.id)!;
}

export function listClassifications(db: Db): StoredClassification[] {
  return db.prepare("SELECT * FROM classifications ORDER BY id").all() as unknown as StoredClassification[];
}
