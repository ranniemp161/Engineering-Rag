import { connect, type Database } from "@tursodatabase/database";
import fsx from "fs-native-extensions";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class IndexBusyError extends Error {}

export async function withIndex<T>(
  file: string,
  readonly: boolean,
  operation: (db: Database) => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true });
  for (const suffix of ["", ".guard", "-wal", "-shm", "-journal"]) {
    const info = await lstat(file + suffix).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    if (info && (!info.isFile() || info.nlink !== 1))
      throw new Error("Index and sidecars must be ordinary private files");
  }
  const guard = await open(`${file}.guard`, "a+");
  try {
    const deadline = performance.now() + 1000;
    while (!fsx.tryLock(guard.fd)) {
      if (performance.now() >= deadline)
        throw new IndexBusyError(
          "INDEX_BUSY: retry after the active index operation finishes",
        );
      await delay(20);
    }
    const db = await connect(file, {
      readonly,
      experimental: ["index_method"],
    });
    try {
      await db.exec("PRAGMA foreign_keys=ON");
      return await operation(db);
    } finally {
      await db.close();
    }
  } finally {
    await guard.close();
  }
}

// Version 2 adds chunk embeddings for optional hybrid retrieval.
const EMBEDDINGS = `
  CREATE TABLE chunk_embeddings(chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL, embedding BLOB NOT NULL);`;

/**
 * Creates or upgrades the index schema and returns its version. A read-only
 * connection accepts version 1, which simply has no embeddings to search.
 */
export async function migrate(db: Database, readonly: boolean): Promise<number> {
  const tables = await db.all(
    "SELECT name FROM sqlite_schema WHERE type='table'",
  );
  if (tables.some((row) => row.name === "engineering_index_version")) {
    const version = (
      await db.get("SELECT version FROM engineering_index_version")
    )?.version;
    if (version === 2 || (version === 1 && readonly)) return version;
    if (version !== 1) throw new Error("Unsupported engineering index schema");
    await db.transactionAsync(async (tx) => {
      await tx.exec(EMBEDDINGS);
      await tx.exec("UPDATE engineering_index_version SET version = 2");
    })();
    return 2;
  }
  if (tables.length || readonly)
    throw new Error("Expected an Engineering Intelligence index");
  await db.transactionAsync(async (tx) => {
    await tx.exec(`
      CREATE TABLE engineering_index_version(version INTEGER NOT NULL);
      INSERT INTO engineering_index_version VALUES (2);
      CREATE TABLE scopes(id TEXT PRIMARY KEY, display_name TEXT NOT NULL, root_path TEXT NOT NULL, scope_type TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE documents(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, title TEXT NOT NULL, tags TEXT NOT NULL, content_hash TEXT NOT NULL,
        file_size INTEGER NOT NULL, modified_at TEXT NOT NULL, indexed_at TEXT NOT NULL, source_text TEXT NOT NULL,
        UNIQUE(scope_id,relative_path));
      CREATE TABLE chunks(id INTEGER PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, heading_path TEXT NOT NULL,
        content TEXT NOT NULL, UNIQUE(document_id,ordinal));
      CREATE INDEX chunk_search ON chunks USING fts(content);
      CREATE TABLE index_runs(id TEXT PRIMARY KEY, scope_id TEXT NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
        started_at TEXT NOT NULL, finished_at TEXT NOT NULL, status TEXT NOT NULL, scanned INTEGER NOT NULL,
        updated INTEGER NOT NULL, removed INTEGER NOT NULL);
      CREATE TABLE index_errors(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES index_runs(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL);
      ${EMBEDDINGS}
    `);
  })();
  return 2;
}
