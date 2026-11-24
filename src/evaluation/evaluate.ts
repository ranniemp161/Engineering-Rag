import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import {
  type SearchOptions,
  searchKnowledge,
} from "../retrieval/search-service.ts";

const text = z.string().trim().min(1);
const expectation = z.strictObject({
  path: text,
  scope: text.optional(),
  lines: z
    .tuple([z.number().int().positive(), z.number().int().positive()])
    .refine(([start, end]) => start <= end, "lines must be [start, end]")
    .optional(),
});
const evalCase = z.strictObject({
  id: text,
  query: z.string().min(1).max(512),
  projectId: text.optional(),
  expect: z.array(expectation).min(1),
  tags: z.array(text).default([]),
  note: z.string().optional(),
});
const evalFile = z.strictObject({ cases: z.array(evalCase).min(1) });

export type EvalCase = z.infer<typeof evalCase>;

export interface CaseResult {
  id: string;
  query: string;
  projectId: string | null;
  tags: string[];
  /** One-based rank of the first result that satisfies an expectation. */
  rank: number | null;
  /** Fraction of expectations satisfied within the top 5 results. */
  recallAt5: number;
  latencyMs: number;
  top: { scope: string; path: string; lines: [number, number]; score: number }[];
  error?: string;
}

export interface Summary {
  cases: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  hitAtDepth: number;
  mrr: number;
  recallAt5: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
}

export interface EvalReport {
  generatedAt: string;
  file: string;
  /** Older reports predate hybrid retrieval and omit these. */
  mode?: "keyword" | "hybrid";
  model?: string | null;
  depth: number;
  summary: Summary;
  byTag: Record<string, Summary>;
  byProject: Record<string, Summary>;
  cases: CaseResult[];
}

export async function loadEvalCases(file: string, config: Config) {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read evaluation cases at ${file}: ${(error as Error).message}`,
    );
  }
  const parsed = evalFile.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      `Invalid evaluation file: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join(", ")}`,
    );
  const ids = new Set<string>();
  const projects = new Set(
    config.scopes.filter((s) => s.type === "project").map((s) => s.id),
  );
  for (const item of parsed.data.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate evaluation case: ${item.id}`);
    ids.add(item.id);
    if (item.projectId && !projects.has(item.projectId))
      throw new Error(
        `Case ${item.id} uses unconfigured project ${item.projectId}`,
      );
    for (const e of item.expect) {
      const scope = e.scope ?? item.projectId ?? "shared";
      // A search only sees shared notes and the requested project.
      if (scope !== "shared" && scope !== item.projectId)
        throw new Error(
          `Case ${item.id} expects scope ${scope}, which its search cannot reach`,
        );
    }
  }
  return parsed.data.cases;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
}

export function summarize(results: CaseResult[]): Summary {
  const n = results.length || 1;
  const hit = (k: number) =>
    round(results.filter((r) => r.rank !== null && r.rank <= k).length / n);
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  return {
    cases: results.length,
    hitAt1: hit(1),
    hitAt3: hit(3),
    hitAt5: hit(5),
    hitAtDepth: hit(Number.POSITIVE_INFINITY),
    mrr: round(results.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / n),
    recallAt5: round(results.reduce((sum, r) => sum + r.recallAt5, 0) / n),
    latencyP50Ms: round(percentile(latencies, 0.5)),
    latencyP95Ms: round(percentile(latencies, 0.95)),
  };
}

function group(results: CaseResult[], keys: (r: CaseResult) => string[]) {
  const groups = new Map<string, CaseResult[]>();
  for (const result of results)
    for (const key of keys(result))
      groups.set(key, [...(groups.get(key) ?? []), result]);
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, items]) => [key, summarize(items)]),
  );
}

/**
 * Runs each case through the same search service the MCP tool uses and
 * scores where the expected source passages rank. Search errors count as
 * misses so one broken case does not hide the rest of the report.
 */
export async function runEvaluation(
  config: Config,
  cases: EvalCase[],
  file: string,
  options: SearchOptions & { mode: "keyword" | "hybrid" } = {
    mode: config.semantic ? "hybrid" : "keyword",
  },
): Promise<EvalReport> {
  const depth = config.search.maxLimit;
  const model =
    options.mode === "hybrid"
      ? (options.embedder?.model ?? config.semantic?.model ?? null)
      : null;
  const results: CaseResult[] = [];
  for (const item of cases) {
    const started = performance.now();
    let found: Awaited<ReturnType<typeof searchKnowledge>>["results"] = [];
    let error: string | undefined;
    try {
      found = (
        await searchKnowledge(
          config,
          { query: item.query, projectId: item.projectId, limit: depth },
          options,
        )
      ).results;
    } catch (failure) {
      error = (failure as Error).message;
    }
    const latencyMs = round(performance.now() - started);
    const satisfies = (
      r: (typeof found)[number],
      e: EvalCase["expect"][number],
    ) =>
      r.scope === (e.scope ?? item.projectId ?? "shared") &&
      r.relativePath === e.path &&
      (!e.lines || (r.startLine <= e.lines[1] && r.endLine >= e.lines[0]));
    const index = found.findIndex((r) =>
      item.expect.some((e) => satisfies(r, e)),
    );
    const top5 = found.slice(0, 5);
    results.push({
      id: item.id,
      query: item.query,
      projectId: item.projectId ?? null,
      tags: item.tags,
      rank: index < 0 ? null : index + 1,
      recallAt5: round(
        item.expect.filter((e) => top5.some((r) => satisfies(r, e))).length /
          item.expect.length,
      ),
      latencyMs,
      top: found.slice(0, 3).map((r) => ({
        scope: r.scope,
        path: r.relativePath,
        lines: [r.startLine, r.endLine],
        score: round(r.score),
      })),
      ...(error ? { error } : {}),
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    file: path.basename(file),
    mode: options.mode,
    model,
    depth,
    summary: summarize(results),
    byTag: group(results, (r) => (r.tags.length ? r.tags : ["untagged"])),
    byProject: group(results, (r) => [r.projectId ?? "shared"]),
    cases: results,
  };
}

export interface Comparison {
  baselineGeneratedAt: string;
  delta: Record<keyof Summary, number>;
  /** Cases in the top 5 for the baseline that fell out of it. */
  regressions: { id: string; before: number | null; after: number | null }[];
  improvements: { id: string; before: number | null; after: number | null }[];
  added: string[];
  removed: string[];
}

export function compareReports(baseline: EvalReport, current: EvalReport): Comparison {
  const before = new Map(baseline.cases.map((c) => [c.id, c.rank]));
  const after = new Map(current.cases.map((c) => [c.id, c.rank]));
  const inTop5 = (rank: number | null | undefined) =>
    rank !== null && rank !== undefined && rank <= 5;
  const changes = (wanted: (b: boolean, a: boolean) => boolean) =>
    current.cases
      .filter((c) => before.has(c.id) && wanted(inTop5(before.get(c.id)), inTop5(c.rank)))
      .map((c) => ({ id: c.id, before: before.get(c.id) ?? null, after: c.rank }));
  const delta = Object.fromEntries(
    (Object.keys(current.summary) as (keyof Summary)[]).map((key) => [
      key,
      round(current.summary[key] - (baseline.summary[key] ?? 0)),
    ]),
  ) as Record<keyof Summary, number>;
  return {
    baselineGeneratedAt: baseline.generatedAt,
    delta,
    regressions: changes((b, a) => b && !a),
    improvements: changes((b, a) => !b && a),
    added: current.cases.filter((c) => !before.has(c.id)).map((c) => c.id),
    removed: baseline.cases.filter((c) => !after.has(c.id)).map((c) => c.id),
  };
}

export async function readReport(file: string): Promise<EvalReport> {
  try {
    const report = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(report?.cases) || typeof report?.summary !== "object")
      throw new Error("not an evaluation report");
    return report as EvalReport;
  } catch (error) {
    throw new Error(
      `Cannot read baseline report at ${file}: ${(error as Error).message}`,
    );
  }
}
