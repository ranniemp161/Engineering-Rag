import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import { RetrievalError, withScopedIndex } from "./scoped-index.ts";

export const searchInput = z.strictObject({
  query: z.string().min(1).max(512),
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(20).optional(),
});

export interface SearchResult {
  documentId: string;
  scope: string;
  title: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

// Keep FTS scoring inside this materialized query. Joining documents before
// ranking can turn valid matches into zero-score rows on Turso 0.8.4.
const rankedQuery = `
  WITH ranked AS MATERIALIZED (
    SELECT id, fts_score(content, ?1) AS score
    FROM chunks WHERE fts_match(content, ?1) ORDER BY score DESC
  )
  SELECT d.id AS documentId, d.scope_id AS scope, substr(d.title, 1, 256) AS title,
         d.relative_path AS relativePath, c.start_line AS startLine, c.content, r.score
  FROM ranked r
  CROSS JOIN chunks c ON c.id = r.id
  CROSS JOIN documents d ON d.id = c.document_id
  WHERE d.scope_id IN ('shared', ?2)
  ORDER BY r.score DESC, d.id, c.ordinal LIMIT ?3 OFFSET ?4`;

function excerpt(content: string, firstLine: number, keywords: RegExp) {
  const match = keywords.exec(content);
  let start = match
    ? Math.max(0, match.index - 100)
    : content.length - content.trimStart().length;
  if (/[\uDC00-\uDFFF]/.test(content.charAt(start))) start++;
  const raw = content.slice(start, start + 400).replace(/[\uD800-\uDBFF]$/, "");
  const snippet = raw.trim();
  const offset = start + raw.length - raw.trimStart().length;
  const startLine = firstLine + content.slice(0, offset).split("\n").length - 1;
  return {
    snippet,
    startLine,
    endLine: startLine + snippet.split("\n").length - 1,
  };
}

function repeatsHit(prior: SearchResult, next: SearchResult, keywords: RegExp) {
  if (prior.documentId !== next.documentId) return false;
  const first = Math.max(prior.startLine, next.startLine);
  const last = Math.min(prior.endLine, next.endLine);
  if (last < first) return false;
  const overlappingText = (r: SearchResult) =>
    r.snippet
      .split("\n")
      .slice(first - r.startLine, last - r.startLine + 1)
      .join("\n");
  const a = overlappingText(prior),
    b = overlappingText(next);
  const shorter = a.length <= b.length ? a : b;
  return keywords.test(shorter) && (a.includes(b) || b.includes(a));
}

export async function searchKnowledge(
  config: Config,
  input: unknown,
): Promise<{ results: SearchResult[] }> {
  const {
    query,
    projectId,
    limit = config.search.defaultLimit,
  } = searchInput.parse(input);
  const terms = [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])];
  if (!terms.length)
    throw new RetrievalError("Search requires at least one word or number");
  if (limit > config.search.maxLimit)
    throw new RetrievalError("Search limit exceeds the configured maximum");
  // Treat user input as literal keywords. Tantivy operators, fields, and
  // punctuation in the original query cannot change the expression structure.
  const expression = terms.map((term) => `"${term}"`).join(" OR ");
  // All terms are literal Unicode words, so none can introduce regex syntax.
  const keywords = new RegExp(terms.join("|"), "iu");
  return withScopedIndex(config, projectId, async (db, scopeId) => {
    const results: SearchResult[] = [];
    const pageSize = limit + 1;
    let bytes = 16;
    for (let offset = 0; results.length < limit; offset += pageSize) {
      const rows = await db.all(
        rankedQuery,
        expression,
        scopeId,
        pageSize,
        offset,
      );
      for (const row of rows) {
        const result: SearchResult = {
          documentId: row.documentId,
          scope: row.scope,
          title: row.title,
          relativePath: row.relativePath,
          score: row.score,
          ...excerpt(row.content, row.startLine, keywords),
        };
        if (results.some((prior) => repeatsHit(prior, result, keywords)))
          continue;
        bytes += Buffer.byteLength(JSON.stringify(result)) + 1;
        if (bytes > 65536) {
          if (!results.length)
            throw new Error(
              "Source citation exceeds the search response size limit",
            );
          return { results };
        }
        results.push(result);
        if (results.length === limit) break;
      }
      if (rows.length < pageSize) break;
    }
    return { results };
  });
}
