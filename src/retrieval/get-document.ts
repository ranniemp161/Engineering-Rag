import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import { RetrievalError, withScopedIndex } from "./scoped-index.ts";

export const documentInput = z.strictObject({
  documentId: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: z.string().min(1).optional(),
  startLine: z.number().int().positive().optional(),
  maxLines: z.number().int().min(1).max(200).optional(),
});

function excerpt(source: string, startLine: number, maxLines: number) {
  const breaks = /\r\n|\n|\r/g;
  for (let line = 1; line < startLine; line++) {
    if (!breaks.exec(source))
      throw new RetrievalError(
        "startLine is past the end of the indexed document",
      );
  }
  const lines: string[] = [];
  let remaining = 8192;
  let nextStartLine: number | null = null;
  let truncatedLine = false;
  for (let i = 0; i < maxLines; i++) {
    const start = breaks.lastIndex;
    const newline = breaks.exec(source);
    const end = newline?.index ?? source.length;
    if (end - start > remaining && lines.length) break;
    truncatedLine = end - start > remaining;
    let text = source.slice(start, Math.min(start + remaining, end));
    if (truncatedLine) text = text.replace(/[\uD800-\uDBFF]$/, "");
    lines.push(text);
    nextStartLine = newline ? startLine + lines.length : null;
    remaining -= text.length + 1;
    if (!newline || remaining < 0 || truncatedLine) break;
  }
  return {
    startLine,
    endLine: startLine + lines.length - 1,
    text: lines.join("\n"),
    nextStartLine,
    truncatedLine,
  };
}

export async function getDocument(config: Config, input: unknown) {
  const {
    documentId,
    projectId,
    startLine = 1,
    maxLines = 100,
  } = documentInput.parse(input);
  return withScopedIndex(config, projectId, async ({ db }, scopeId) => {
    const row = await db.get(
      "SELECT scope_id, relative_path, substr(title,1,256) AS title, source_text FROM documents WHERE id=? AND scope_id IN ('shared',?)",
      documentId,
      scopeId,
    );
    if (!row)
      throw new RetrievalError("Document unavailable in the requested scope");
    const result = {
      documentId,
      scope: row.scope_id,
      title: row.title,
      relativePath: row.relative_path,
      ...excerpt(row.source_text, startLine, maxLines),
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 65536)
      throw new RetrievalError(
        "Document citation exceeds the response size limit",
      );
    return result;
  });
}
