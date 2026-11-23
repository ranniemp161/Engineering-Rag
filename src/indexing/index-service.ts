import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { Database, Transaction } from "@tursodatabase/database";
import type { Config } from "../config/load-config.ts";
import {
  markdownFiles,
  readNote,
  type ScanError,
} from "../filesystem/markdown-reader.ts";
import { parseMarkdown } from "../markdown/chunk-markdown.ts";

async function scanScope(
  tx: Transaction,
  scope: Config["scopes"][number],
  exclude: string[],
) {
  const started = new Date().toISOString();
  const previous = await tx.get(
    "SELECT root_path FROM scopes WHERE id=?",
    scope.id,
  );
  if (previous && path.relative(previous.root_path, scope.rootPath) !== "")
    throw new Error(
      `Scope ${scope.id} changed roots. Use rebuild to replace its previous index.`,
    );
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

export async function indexNotes(
  db: Database,
  config: Config,
  rebuild: boolean,
  scopeIds?: ReadonlySet<string>,
) {
  const scan = (tx: Transaction, scope: Config["scopes"][number]) =>
    scanScope(tx, scope, config.exclude);
  if (scopeIds && rebuild)
    throw new Error("Rebuild always replaces every configured scope");
  if (scopeIds) {
    const result = [];
    for (const scope of config.scopes)
      if (scopeIds.has(scope.id))
        result.push(await db.transactionAsync(scan)(scope));
    return result;
  }
  if (rebuild)
    return db.transactionAsync(async (tx) => {
      await tx.exec("DELETE FROM scopes");
      const result = [];
      for (const scope of config.scopes) {
        const summary = await scan(tx, scope);
        if (summary.errors.length)
          throw new Error(
            `Rebuild rolled back for ${scope.id}: ${JSON.stringify(summary.errors)}`,
          );
        result.push(summary);
      }
      return result;
    })();
  const result = [];
  for (const scope of config.scopes)
    result.push(await db.transactionAsync(scan)(scope));
  return result;
}

export async function indexStatus(db: Database) {
  const scopes = [];
  const semantic = await db.get(
    "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='chunk_embeddings'",
  );
  for (const { id } of await db.all("SELECT id FROM scopes ORDER BY id")) {
    const counts = await db.get(
      `SELECT COUNT(DISTINCT d.id) AS documents,COUNT(c.id) AS chunks FROM documents d
      LEFT JOIN chunks c ON c.document_id=d.id WHERE d.scope_id=?`,
      id,
    );
    // Vectors per model, so a partly embedded scope or a model change is visible.
    const embeddings = semantic
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
