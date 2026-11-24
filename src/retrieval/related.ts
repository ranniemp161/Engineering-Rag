import path from "node:path";
import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import type { ReferenceKind } from "../markdown/references.ts";
import { RetrievalError, withScopedIndex } from "./scoped-index.ts";

export const relatedInput = z.strictObject({
  documentId: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

interface VisibleDocument {
  id: string;
  scope: string;
  relativePath: string;
  title: string;
}

interface Citation {
  line: number;
  kind: ReferenceKind;
  context: string;
}

export interface RelatedDocument {
  documentId: string;
  scope: string;
  title: string;
  relativePath: string;
  /** Up to 5 lines that carry the reference, in the citing document. */
  references: Citation[];
}

const MAX_CITATIONS = 5;
const MAX_CONTEXT = 200;
// A numbered record's file name starts with its number, as in 0020-title.md.
const NUMBERED = /^(\d{3,6})(?:-|$)/;

const stem = (relativePath: string) =>
  path.posix.basename(relativePath).replace(/\.md$/i, "").toLowerCase();

/**
 * Resolves stored references against the documents visible to one request.
 * Paths and numbers resolve within the citing document's scope; a wikilink
 * name may also resolve to a shared note. Ambiguous names resolve to nothing.
 */
function resolver(documents: VisibleDocument[]) {
  const byPath = new Map<string, string>();
  const byName = new Map<string, string[]>();
  const byNumber = new Map<string, string[]>();
  const push = (map: Map<string, string[]>, key: string, id: string) =>
    map.set(key, [...(map.get(key) ?? []), id]);
  for (const doc of documents) {
    byPath.set(`${doc.scope}\0${doc.relativePath.toLowerCase()}`, doc.id);
    push(byName, `${doc.scope}\0${stem(doc.relativePath)}`, doc.id);
    const number = NUMBERED.exec(stem(doc.relativePath))?.[1];
    if (number) push(byNumber, `${doc.scope}\0${number}`, doc.id);
  }
  const unique = (ids: string[] | undefined) =>
    ids?.length === 1 ? ids[0] : undefined;
  const inScope = (scope: string, relative: string) => {
    const normalized = path.posix.normalize(relative).replace(/^\.\//, "");
    if (normalized.startsWith("../") || path.posix.isAbsolute(normalized))
      return undefined;
    return byPath.get(`${scope}\0${normalized.toLowerCase()}`);
  };
  return (
    kind: ReferenceKind,
    target: string,
    source: { scope: string; relativePath: string },
  ): string | undefined => {
    if (kind === "link")
      return inScope(
        source.scope,
        path.posix.join(path.posix.dirname(source.relativePath), target),
      );
    if (kind === "number")
      return unique(byNumber.get(`${source.scope}\0${target}`));
    const file = /\.md$/i.test(target) ? target : `${target}.md`;
    if (target.includes("/"))
      return inScope(source.scope, file) ?? inScope("shared", file);
    const name = target.toLowerCase().replace(/\.md$/i, "");
    return (
      unique(byName.get(`${source.scope}\0${name}`)) ??
      unique(byName.get(`shared\0${name}`))
    );
  };
}

function lineText(source: string, line: number) {
  const text = source.split(/\r\n|\n|\r/)[line - 1]?.trim() ?? "";
  return text.length > MAX_CONTEXT ? `${text.slice(0, MAX_CONTEXT - 1)}…` : text;
}

/**
 * Returns the notes a document links to and the notes that link to it, within
 * the scopes the request may see. Links come from explicit Markdown links,
 * wikilinks and numbered references such as decision 0020; nothing is inferred.
 */
export async function getRelatedDocuments(config: Config, input: unknown) {
  const { documentId, projectId, limit = 20 } = relatedInput.parse(input);
  return withScopedIndex(config, projectId, async (db, scopeId) => {
    if (
      !(await db.get(
        "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='document_references'",
      ))
    )
      throw new RetrievalError(
        "Links are unavailable until the index is upgraded. Run the index command.",
      );
    const documents: VisibleDocument[] = (
      await db.all(
        "SELECT id, scope_id, relative_path, substr(title,1,256) AS title FROM documents WHERE scope_id IN ('shared',?)",
        scopeId,
      )
    ).map((row) => ({
      id: row.id,
      scope: row.scope_id,
      relativePath: row.relative_path,
      title: row.title,
    }));
    const byId = new Map(documents.map((doc) => [doc.id, doc]));
    const self = byId.get(documentId);
    if (!self)
      throw new RetrievalError("Document unavailable in the requested scope");
    const resolve = resolver(documents);
    const sources = new Map<string, string>();
    const sourceOf = async (id: string) => {
      let text = sources.get(id);
      if (text === undefined) {
        text = String(
          (await db.get("SELECT source_text FROM documents WHERE id=?", id))
            ?.source_text ?? "",
        );
        sources.set(id, text);
      }
      return text;
    };

    const collect = async (
      rows: { document_id: string; line: number; kind: ReferenceKind; target: string }[],
      direction: "outgoing" | "incoming",
    ) => {
      const grouped = new Map<string, RelatedDocument>();
      for (const row of rows) {
        const from = byId.get(row.document_id);
        if (!from) continue;
        const to = resolve(row.kind, row.target, from);
        if (!to || to === from.id) continue;
        if (direction === "incoming" && to !== documentId) continue;
        const other = byId.get(direction === "outgoing" ? to : from.id);
        if (!other) continue;
        const entry = grouped.get(other.id) ?? {
          documentId: other.id,
          scope: other.scope,
          title: other.title,
          relativePath: other.relativePath,
          references: [],
        };
        if (
          entry.references.length < MAX_CITATIONS &&
          !entry.references.some((c) => c.line === row.line)
        )
          entry.references.push({
            line: row.line,
            kind: row.kind,
            context: lineText(await sourceOf(from.id), row.line),
          });
        grouped.set(other.id, entry);
      }
      return [...grouped.values()];
    };

    const outgoing = await collect(
      (await db.all(
        "SELECT document_id, line, kind, target FROM document_references WHERE document_id=? ORDER BY line, id",
        documentId,
      )) as never,
      "outgoing",
    );
    // Incoming candidates: references from visible documents that could name this one.
    const incoming = (
      await collect(
        (await db.all(
          `SELECT r.document_id, r.line, r.kind, r.target FROM document_references r
           JOIN documents d ON d.id = r.document_id
           WHERE d.scope_id IN ('shared', ?) AND r.document_id <> ?
           ORDER BY d.relative_path, r.line, r.id`,
          scopeId,
          documentId,
        )) as never,
        "incoming",
      )
    ).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    const result = {
      documentId,
      scope: self.scope,
      title: self.title,
      relativePath: self.relativePath,
      outgoingTotal: outgoing.length,
      incomingTotal: incoming.length,
      outgoing: outgoing.slice(0, limit),
      incoming: incoming.slice(0, limit),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      throw new RetrievalError("Related documents exceed the response size limit");
    return result;
  });
}
