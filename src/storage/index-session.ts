import { connect, type Database } from "@tursodatabase/database";
import { extractReferences } from "../markdown/references.ts";
import fsx from "fs-native-extensions";
import { access, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config/load-config.ts";

/** Errors whose messages are safe to show a host or browser: no paths, no SQL. */
export class IndexError extends Error {}
export class IndexMissingError extends IndexError {}
export class IndexBusyError extends IndexError {}
export class IndexRootChangedError extends IndexError {}
export class UnknownScopeError extends IndexError {}
export class IndexUpgradeNeededError extends IndexError {
  constructor(capability: keyof IndexCapabilities) {
    super(UPGRADE_MESSAGES[capability]);
  }
}

const UPGRADE_MESSAGES: Record<keyof IndexCapabilities, string> = {
  embeddings:
    "Embeddings are unavailable until the index is upgraded. Run the index command.",
  references:
    "Links are unavailable until the index is upgraded. Run the index command.",
};

export type SessionConfig = {
  databasePath: Config["databasePath"];
  scopes: readonly Pick<Config["scopes"][number], "id" | "rootPath">[];
};

/** Schema features of the opened index. Read sessions may see older schemas. */
export type IndexCapabilities = { embeddings: boolean; references: boolean };

export type IndexSession = { db: Database; capabilities: IndexCapabilities };

/** A write session also records which scopes it may change, and whether it rebuilds. */
export type WriteSession = IndexSession & {
  scopeIds: readonly string[];
  rebuild: boolean;
};

/**
 * Opens the index read-only under the shared guard. A missing index creates
 * nothing: it returns `whenMissing()` when given, and otherwise throws
 * IndexMissingError. Throws IndexRootChangedError when an indexed root of
 * `scopeIds` no longer matches the configuration.
 */
export async function withReadSession<T, M = never>(
  config: SessionConfig,
  scopeIds: readonly string[],
  operation: (session: IndexSession) => Promise<T>,
  options: { whenMissing?: () => M } = {},
): Promise<T | M> {
  knownScopes(config, scopeIds);
  const present = await access(config.databasePath).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    },
  );
  if (!present) {
    if (options.whenMissing) return options.whenMissing();
    throw new IndexMissingError("Index missing. Run the index command first.");
  }
  return guarded(config.databasePath, true, async (db) => {
    const capabilities = capabilitiesOf(await migrate(db, true));
    await verifyRoots(db, config, scopeIds, () =>
      new IndexRootChangedError("Indexed scope root has changed. Rebuild the index."),
    );
    return operation({ db, capabilities });
  });
}

/**
 * Opens the index for writing, creating or upgrading the schema. Unless
 * rebuilding, refuses a scope in `scopeIds` whose indexed root has moved.
 */
export async function withWriteSession<T>(
  config: SessionConfig,
  scopeIds: readonly string[],
  operation: (session: WriteSession) => Promise<T>,
  options: { rebuild?: boolean } = {},
): Promise<T> {
  knownScopes(config, scopeIds);
  await mkdir(path.dirname(config.databasePath), { recursive: true });
  return guarded(config.databasePath, false, async (db) => {
    const capabilities = capabilitiesOf(await migrate(db, false));
    const rebuild = options.rebuild ?? false;
    if (!rebuild)
      await verifyRoots(db, config, scopeIds, (id) =>
        new IndexRootChangedError(
          `Scope ${id} changed roots. Use rebuild to replace its previous index.`,
        ),
      );
    return operation({ db, capabilities, scopeIds, rebuild });
  });
}

function knownScopes(config: SessionConfig, scopeIds: readonly string[]) {
  for (const id of scopeIds)
    if (!config.scopes.some((scope) => scope.id === id))
      // The shared scope is required by configuration, so only a project can be unknown.
      throw new UnknownScopeError("Unknown project ID");
}

function capabilitiesOf(version: number): IndexCapabilities {
  return { embeddings: version >= 2, references: version >= 3 };
}

async function verifyRoots(
  db: Database,
  config: SessionConfig,
  scopeIds: readonly string[],
  changed: (id: string) => IndexError,
) {
  if (!scopeIds.length) return;
  const rows = await db.all(
    `SELECT id,root_path FROM scopes WHERE id IN (${scopeIds.map(() => "?").join(",")})`,
    ...scopeIds,
  );
  for (const row of rows) {
    const scope = config.scopes.find((s) => s.id === row.id);
    if (!scope || path.relative(scope.rootPath, row.root_path) !== "")
      throw changed(row.id);
  }
}

async function guarded<T>(
  file: string,
  readonly: boolean,
  operation: (db: Database) => Promise<T>,
): Promise<T> {
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

// Version 3 adds explicit references between notes, resolved at query time.
const REFERENCES = `
  CREATE TABLE document_references(id INTEGER PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    line INTEGER NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL);
  CREATE INDEX document_references_document ON document_references(document_id);`;

const SCHEMA_VERSION = 3;

export async function writeReferences(
  tx: Pick<Database, "run" | "prepare">,
  documentId: string,
  source: string,
) {
  await tx.run("DELETE FROM document_references WHERE document_id=?", documentId);
  const insert = await tx.prepare(
    "INSERT INTO document_references(document_id,line,kind,target) VALUES(?,?,?,?)",
  );
  for (const r of extractReferences(source))
    await insert.run(documentId, r.line, r.kind, r.target);
}

/**
 * Creates or upgrades the index schema and returns its version. A read-only
 * connection accepts older versions; features they lack report that the
 * index needs a write to upgrade.
 */
async function migrate(db: Database, readonly: boolean): Promise<number> {
  const tables = await db.all(
    "SELECT name FROM sqlite_schema WHERE type='table'",
  );
  if (tables.some((row) => row.name === "engineering_index_version")) {
    const version = (
      await db.get("SELECT version FROM engineering_index_version")
    )?.version;
    if (![1, 2, SCHEMA_VERSION].includes(version))
      throw new Error("Unsupported engineering index schema");
    if (version === SCHEMA_VERSION || readonly) return version;
    await db.transactionAsync(async (tx) => {
      if (version < 2) await tx.exec(EMBEDDINGS);
      // Existing notes are unchanged by hash, so backfill their references here.
      await tx.exec(REFERENCES);
      for (const row of await tx.all("SELECT id, source_text FROM documents"))
        await writeReferences(tx, row.id, row.source_text);
      await tx.exec(`UPDATE engineering_index_version SET version = ${SCHEMA_VERSION}`);
    })();
    return SCHEMA_VERSION;
  }
  if (tables.length || readonly)
    throw new Error("Expected an Engineering Intelligence index");
  await db.transactionAsync(async (tx) => {
    await tx.exec(`
      CREATE TABLE engineering_index_version(version INTEGER NOT NULL);
      INSERT INTO engineering_index_version VALUES (${SCHEMA_VERSION});
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
      ${REFERENCES}
    `);
  })();
  return SCHEMA_VERSION;
}
