import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Transaction } from "@tursodatabase/database";
import type { Config } from "../config/load-config.ts";
import {
  markdownFiles,
  readNote,
  type ScanError,
} from "../filesystem/markdown-reader.ts";
import { parseMarkdown } from "../markdown/chunk-markdown.ts";
import { embedPending } from "../semantic/embed-index.ts";
import { type Embedder, getEmbedder } from "../semantic/embedder.ts";
import {
  type IndexSession,
  type WriteSession,
  withWriteSession,
  writeReferences,
} from "../storage/index-session.ts";

async function scanScope(
  tx: Transaction,
  scope: Config["scopes"][number],
  exclude: string[],
) {
  const started = new Date().toISOString();
  // The write session has already refused a moved root unless rebuilding.
  await tx.run(
    "INSERT INTO scopes VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name",
    scope.id,
    scope.displayName,
    scope.rootPath,
    scope.type,
    started,
  );
  const known = new Map<string, string>();
  for (const row of await tx.all(
    "SELECT relative_path,content_hash FROM documents WHERE scope_id=?",
    scope.id,
  ))
    known.set(row.relative_path, row.content_hash);
  const errors: ScanError[] = [];
  const insert = await tx.prepare(
    "INSERT INTO chunks(document_id,ordinal,start_line,end_line,heading_path,content) VALUES(?,?,?,?,?,?)",
  );
  let scanned = 0,
    updated = 0,
    removed = 0;
  for await (const key of markdownFiles(scope.rootPath, exclude, errors)) {
    scanned++;
    const old = known.get(key);
    known.delete(key);
    let note: Awaited<ReturnType<typeof readNote>>;
    try {
      note = await readNote(scope.rootPath, key);
    } catch (error) {
      errors.push({
        relativePath: key,
        code: "FILE_UNAVAILABLE",
        message:
          (error as NodeJS.ErrnoException).code ??
          "Cannot read a stable source file",
      });
      continue;
    }
    const hash = createHash("sha256").update(note.bytes).digest("hex");
    if (old === hash) continue;
    const id = createHash("sha256")
      .update(JSON.stringify([scope.id, key]))
      .digest("hex");
    const source = note.bytes.toString("utf8");
    const parsed = parseMarkdown(source, path.parse(key).name);
    await tx.run(
      `INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,tags=excluded.tags,content_hash=excluded.content_hash,
      file_size=excluded.file_size,modified_at=excluded.modified_at,indexed_at=excluded.indexed_at,source_text=excluded.source_text`,
      id,
      scope.id,
      key,
      parsed.title,
      JSON.stringify(parsed.tags),
      hash,
      note.bytes.length,
      note.modifiedAt,
      new Date().toISOString(),
      source,
    );
    await writeReferences(tx, id, source);
    await tx.run("DELETE FROM chunks WHERE document_id=?", id);
    for (const [ordinal, chunk] of parsed.chunks.entries())
      await insert.run(
        id,
        ordinal,
        chunk.startLine,
        chunk.endLine,
        chunk.headingPath,
        chunk.content,
      );
    updated++;
  }
  if (!errors.some((error) => error.code === "DIRECTORY_UNAVAILABLE")) {
    for (const key of known.keys()) {
      await tx.run(
        "DELETE FROM documents WHERE scope_id=? AND relative_path=?",
        scope.id,
        key,
      );
      removed++;
    }
  }
  const run = randomUUID();
  const status = errors.length ? "partial" : "complete";
  await tx.run(
    "INSERT INTO index_runs VALUES(?,?,?,?,?,?,?,?)",
    run,
    scope.id,
    started,
    new Date().toISOString(),
    status,
    scanned,
    updated,
    removed,
  );
  for (const issue of errors)
    await tx.run(
      "INSERT INTO index_errors(run_id,relative_path,code,message) VALUES(?,?,?,?)",
      run,
      issue.relativePath,
      issue.code,
      issue.message,
    );
  return {
    scope: scope.id,
    status,
    scanned,
    updated,
    unchanged:
      scanned -
      updated -
      errors.filter((e) => e.code === "FILE_UNAVAILABLE").length,
    removed,
    errors,
  };
}

/** Which scopes an index refresh covers. A rebuild always covers every scope. */
export type RefreshRequest =
  | { kind: "all" }
  | { kind: "scopes"; ids: readonly string[] }
  | { kind: "rebuild" };

export type ScanSummary = Awaited<ReturnType<typeof indexNotes>>[number];

/** Embedding outcome of a refresh. Failures leave the committed scan in place. */
export type EmbeddingOutcome =
  | { status: "off" }
  | ({ status: "updated" } & Awaited<ReturnType<typeof embedPending>>)
  | { status: "failed"; stage: "model" | "embed"; message: string };

export type RefreshResult = { scans: ScanSummary[]; embedding: EmbeddingOutcome };

/**
 * Scans the requested scopes, then embeds new passages when `semantic` is
 * configured. The model loads before the index guard is taken, so a slow or
 * missing model never holds the index. Scan errors and embedding failures are
 * returned; index session errors such as a busy index or moved root throw.
 */
export async function refreshIndex(
  config: Config,
  request: RefreshRequest,
  options: { embedder?: Embedder; embedBatchSize?: number } = {},
): Promise<RefreshResult> {
  // Embeddings run only when configured; an injected embedder replaces loading the model.
  let embedder: Embedder | undefined;
  let modelFailure: string | undefined;
  if (config.semantic)
    embedder =
      options.embedder ??
      (await getEmbedder(config.semantic).catch((error: Error) => {
        modelFailure = error.message;
        return undefined;
      }));
  const ids =
    request.kind === "scopes" ? request.ids : config.scopes.map((scope) => scope.id);
  const rebuild = request.kind === "rebuild";
  return withWriteSession(
    config,
    ids,
    async (session) => {
      const scans = await indexNotes(session, config);
      let embedding: EmbeddingOutcome = { status: "off" };
      if (modelFailure !== undefined)
        embedding = { status: "failed", stage: "model", message: modelFailure };
      else if (embedder)
        embedding = await embedPending(session.db, embedder, options.embedBatchSize).then(
          (counts): EmbeddingOutcome => ({ status: "updated", ...counts }),
          (error: Error): EmbeddingOutcome => ({
            status: "failed",
            stage: "embed",
            message: error.message,
          }),
        );
      return { scans, embedding };
    },
    { rebuild },
  );
}

/**
 * Scans the scopes the write session was opened for; their roots are already
 * verified. A rebuild replaces every configured scope in one transaction.
 */
async function indexNotes(session: WriteSession, config: Config) {
  const { db, rebuild } = session;
  const scopeIds = new Set(session.scopeIds);
  const scopes = config.scopes.filter((scope) => scopeIds.has(scope.id));
  const scan = (tx: Transaction, scope: Config["scopes"][number]) =>
    scanScope(tx, scope, config.exclude);
  if (rebuild) {
    if (scopes.length !== config.scopes.length)
      throw new Error("Rebuild always replaces every configured scope");
    return db.transactionAsync(async (tx) => {
      await tx.exec("DELETE FROM scopes");
      const result = [];
      for (const scope of scopes) {
        const summary = await scan(tx, scope);
        if (summary.errors.length)
          throw new Error(
            `Rebuild rolled back for ${scope.id}: ${JSON.stringify(summary.errors)}`,
          );
        result.push(summary);
      }
      return result;
    })();
  }
  const result = [];
  for (const scope of scopes) result.push(await db.transactionAsync(scan)(scope));
  return result;
}

export async function indexStatus({ db, capabilities }: IndexSession) {
  const scopes = [];
  const hasEmbeddings = capabilities.embeddings;
  for (const { id } of await db.all("SELECT id FROM scopes ORDER BY id")) {
    const counts = await db.get(
      `SELECT COUNT(DISTINCT d.id) AS documents,COUNT(c.id) AS chunks FROM documents d
      LEFT JOIN chunks c ON c.document_id=d.id WHERE d.scope_id=?`,
      id,
    );
    // Vectors per model, so a partly embedded scope or a model change is visible.
    const embeddings = hasEmbeddings
      ? Object.fromEntries(
          (
            await db.all(
              `SELECT e.model, COUNT(*) AS n FROM chunk_embeddings e
              JOIN chunks c ON c.id=e.chunk_id JOIN documents d ON d.id=c.document_id
              WHERE d.scope_id=? GROUP BY e.model ORDER BY e.model`,
              id,
            )
          ).map((row) => [row.model, row.n]),
        )
      : {};
    const latest = await db.get(
      "SELECT id,status,finished_at,scanned,updated,removed FROM index_runs WHERE scope_id=? ORDER BY rowid DESC LIMIT 1",
      id,
    );
    const success = await db.get(
      "SELECT MAX(finished_at) AS lastSuccess FROM index_runs WHERE scope_id=? AND status='complete'",
      id,
    );
    const errors = latest
      ? await db.all(
          "SELECT relative_path,code,message FROM index_errors WHERE run_id=? ORDER BY id LIMIT 20",
          latest.id,
        )
      : [];
    scopes.push({ id, ...counts, embeddings, ...success, latest, errors });
  }
  return { initialized: true, scopes };
}
