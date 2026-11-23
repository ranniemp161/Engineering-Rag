import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import {
  type Embedder,
  getEmbedder,
  type SemanticConfig,
  SemanticUnavailableError,
  toBlob,
} from "../semantic/embedder.ts";
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

// Candidate depth per ranking before fusion; at least the maximum limit of 20.
const CANDIDATES = 50;
// Standard Reciprocal Rank Fusion constant.
const RRF_K = 60;

const vectorQuery = `
  SELECT d.id AS documentId, d.scope_id AS scope, substr(d.title, 1, 256) AS title,
         d.relative_path AS relativePath, c.start_line AS startLine, c.content, c.id AS chunkId,
         c.ordinal, vector_distance_cos(e.embedding, ?2) AS distance
  FROM chunk_embeddings e
  CROSS JOIN chunks c ON c.id = e.chunk_id
  CROSS JOIN documents d ON d.id = c.document_id
  WHERE e.model = ?1 AND d.scope_id IN ('shared', ?3)
  ORDER BY distance, d.id, c.ordinal LIMIT ?4`;

const keywordCandidates = `
  WITH ranked AS MATERIALIZED (
    SELECT id, fts_score(content, ?1) AS score
    FROM chunks WHERE fts_match(content, ?1) ORDER BY score DESC
  )
  SELECT d.id AS documentId, d.scope_id AS scope, substr(d.title, 1, 256) AS title,
         d.relative_path AS relativePath, c.start_line AS startLine, c.content, c.id AS chunkId,
         c.ordinal, r.score
  FROM ranked r
  CROSS JOIN chunks c ON c.id = r.id
  CROSS JOIN documents d ON d.id = c.document_id
  WHERE d.scope_id IN ('shared', ?2)
  ORDER BY r.score DESC, d.id, c.ordinal LIMIT ?3`;

interface Candidate {
  chunkId: number;
  documentId: string;
  ordinal: number;
  row: Record<string, unknown>;
}

/**
 * Reciprocal Rank Fusion: each list contributes weight / (k + rank). Ties keep
 * the same stable document and chunk order as keyword search.
 */
export function fuseRankings(
  lists: { weight: number; items: Candidate[] }[],
): (Candidate & { score: number })[] {
  const fused = new Map<number, Candidate & { score: number }>();
  for (const { weight, items } of lists)
    for (const [index, item] of items.entries()) {
      const entry = fused.get(item.chunkId) ?? { ...item, score: 0 };
      entry.score += weight / (RRF_K + index + 1);
      fused.set(item.chunkId, entry);
    }
  return [...fused.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
      a.ordinal - b.ordinal,
  );
}

export interface SearchOptions {
  /** Defaults to hybrid when semantic retrieval is configured. */
  mode?: "keyword" | "hybrid";
  /** Overrides the configured model, for example in tests. */
  embedder?: Embedder;
}

export async function searchKnowledge(
  config: Config,
  input: unknown,
  options: SearchOptions = {},
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
  const explicit = options.mode !== undefined;
  const mode = options.mode ?? (config.semantic ? "hybrid" : "keyword");
  if (mode === "hybrid") {
    if (!config.semantic && !options.embedder)
      throw new RetrievalError("Hybrid search needs a semantic configuration");
    let vector: Float32Array | undefined;
    try {
      const embedder =
        options.embedder ?? (await getEmbedder(config.semantic as SemanticConfig));
      [vector] = await embedder.embed([query], "query");
      const result = await hybridSearch(config, {
        projectId,
        limit,
        expression,
        keywords,
        model: embedder.model,
        vector: vector as Float32Array,
        explicit,
      });
      if (result) return result;
    } catch (error) {
      // An explicit hybrid request reports the problem; the default degrades.
      if (explicit || !(error instanceof SemanticUnavailableError)) throw error;
      console.error(`Semantic search unavailable, using keywords: ${error.message}`);
    }
  }
  return keywordSearch(config, projectId, limit, expression, keywords);
}

async function hybridSearch(
  config: Config,
  request: {
    projectId: string | undefined;
    limit: number;
    expression: string;
    keywords: RegExp;
    model: string;
    vector: Float32Array;
    explicit: boolean;
  },
): Promise<{ results: SearchResult[] } | undefined> {
  const { limit, keywords } = request;
  const weights = {
    keyword: config.semantic?.keywordWeight ?? 1,
    semantic: config.semantic?.semanticWeight ?? 1,
  };
  return withScopedIndex(config, request.projectId, async (db, scopeId) => {
    const hasTable = await db.get(
      "SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='chunk_embeddings'",
    );
    const semanticRows = hasTable
      ? await db.all(vectorQuery, request.model, toBlob(request.vector), scopeId, CANDIDATES)
      : [];
    if (!semanticRows.length) {
      const indexed = hasTable
        ? await db.get(
            "SELECT 1 AS present FROM chunk_embeddings WHERE model = ? LIMIT 1",
            request.model,
          )
        : undefined;
      // No vectors for this model yet: keep keyword results rather than guess.
      if (!indexed) {
        if (request.explicit)
          throw new RetrievalError(
            "No embeddings for the configured model. Run the index command.",
          );
        console.error("Semantic search has no embeddings yet, using keywords.");
        return undefined;
      }
    }
    const keywordRows = await db.all(
      keywordCandidates,
      request.expression,
      scopeId,
      CANDIDATES,
    );
    const asCandidate = (row: Record<string, unknown>): Candidate => ({
      chunkId: Number(row.chunkId),
      documentId: String(row.documentId),
      ordinal: Number(row.ordinal),
      row,
    });
    const fused = fuseRankings([
      { weight: weights.keyword, items: keywordRows.map(asCandidate) },
      { weight: weights.semantic, items: semanticRows.map(asCandidate) },
    ]);
    const results: SearchResult[] = [];
    let bytes = 16;
    for (const { row, score } of fused) {
      const result: SearchResult = {
        documentId: String(row.documentId),
        scope: String(row.scope),
        title: String(row.title),
        relativePath: String(row.relativePath),
        score,
        ...excerpt(String(row.content), Number(row.startLine), keywords),
      };
      if (results.some((prior) => repeatsHit(prior, result, keywords))) continue;
      bytes += Buffer.byteLength(JSON.stringify(result)) + 1;
      if (bytes > 65536) {
        if (!results.length)
          throw new Error("Source citation exceeds the search response size limit");
        break;
      }
      results.push(result);
      if (results.length === limit) break;
    }
    return { results };
  });
}

function keywordSearch(
  config: Config,
  projectId: string | undefined,
  limit: number,
  expression: string,
  keywords: RegExp,
): Promise<{ results: SearchResult[] }> {
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
