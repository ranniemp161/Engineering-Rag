import { loadConfig } from "./config/load-config.ts";
import { indexNotes, indexStatus } from "./indexing/index-service.ts";
import { watchNotes } from "./indexing/watch-service.ts";
import { migrate, withIndex } from "./storage/turso.ts";
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareReports,
  loadEvalCases,
  readReport,
  runEvaluation,
} from "./evaluation/evaluate.ts";
import { parseArgs } from "node:util";
import { searchKnowledge } from "./retrieval/search-service.ts";
import { embedPending } from "./semantic/embed-index.ts";
import {
  type Embedder,
  fetchModel,
  getEmbedder,
} from "./semantic/embedder.ts";

function parseMode(value: string | undefined) {
  if (value === undefined || value === "keyword" || value === "hybrid")
    return value;
  throw new Error("--mode must be keyword or hybrid");
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const [command, ...rest] = args;
  if (
    (!["search", "watch", "eval"].includes(command ?? "") &&
      args.length !== 1) ||
    ![
      "index",
      "rebuild",
      "status",
      "search",
      "watch",
      "eval",
      "fetch-model",
    ].includes(command ?? "")
  )
    throw new Error(
      'Usage: pnpm dev -- index|status|rebuild|fetch-model, search "keywords" [--project ID] [--limit N] [--mode keyword|hybrid] [--json], watch [--debounce MS] [--reconcile MINUTES], or eval [--file CASES] [--baseline REPORT] [--output REPORT] [--mode keyword|hybrid]',
    );
  const config = await loadConfig(undefined, { allowUnavailableRoots: true });
  if (command === "fetch-model") {
    if (!config.semantic)
      throw new Error('Add a "semantic" section to the configuration first');
    console.log(JSON.stringify(await fetchModel(config.semantic), null, 2));
  } else if (command === "eval") {
    const { values } = parseArgs({
      args: rest,
      options: {
        file: {
          type: "string",
          default:
            process.env.ENGINEERING_INTELLIGENCE_EVAL ?? "evaluation.local.json",
        },
        baseline: { type: "string" },
        output: { type: "string" },
        mode: { type: "string" },
      },
    });
    const file = path.resolve(values.file);
    const cases = await loadEvalCases(file, config);
    const baseline = values.baseline
      ? await readReport(path.resolve(values.baseline))
      : undefined;
    const report = await runEvaluation(config, cases, file, {
      mode: parseMode(values.mode) ?? (config.semantic ? "hybrid" : "keyword"),
    });
    if (values.output)
      await writeFile(
        path.resolve(values.output),
        `${JSON.stringify(report, null, 2)}\n`,
      );
    const comparison = baseline && compareReports(baseline, report);
    if (comparison?.regressions.length) process.exitCode = 1;
    console.log(JSON.stringify({ ...report, comparison }, null, 2));
  } else if (command === "watch") {
    const { values } = parseArgs({
      args: rest,
      options: {
        debounce: { type: "string", default: "1000" },
        reconcile: { type: "string", default: "15" },
      },
    });
    const debounceMs = Number(values.debounce);
    const reconcileMinutes = Number(values.reconcile);
    if (!Number.isInteger(debounceMs) || debounceMs < 50 || debounceMs > 60_000)
      throw new Error("--debounce must be 50 to 60000 milliseconds");
    if (
      !Number.isFinite(reconcileMinutes) ||
      reconcileMinutes < 0 ||
      reconcileMinutes > 1440
    )
      throw new Error("--reconcile must be 0 (off) to 1440 minutes");
    const stop = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      process.once(signal, () => stop.abort());
    // One JSON object per line so logs can be followed and parsed.
    await watchNotes(config, {
      signal: stop.signal,
      debounceMs,
      reconcileMs: reconcileMinutes * 60_000,
      report: (event) =>
        console.log(JSON.stringify({ at: new Date().toISOString(), ...event })),
    });
  } else if (command === "search") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        limit: { type: "string" },
        mode: { type: "string" },
        json: { type: "boolean" },
      },
    });
    if (positionals.length !== 1)
      throw new Error("Supply one search query, quoting multiple words");
    const output = await searchKnowledge(
      config,
      {
        query: positionals[0],
        projectId: values.project,
        limit: values.limit === undefined ? undefined : Number(values.limit),
      },
      { mode: parseMode(values.mode) },
    );
    console.log(JSON.stringify(output, null, 2));
  } else if (
    command === "status" &&
    !(await stat(config.databasePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }))
  )
    console.log(JSON.stringify({ initialized: false, scopes: [] }));
  else {
    // Load the model before taking the index guard; failure does not block indexing.
    let embedder: Embedder | undefined;
    let embedFailure: string | undefined;
    if (command !== "status" && config.semantic)
      embedder = await getEmbedder(config.semantic).catch((error: Error) => {
        embedFailure = error.message;
        return undefined;
      });
    const output = await withIndex(
      config.databasePath,
      command === "status",
      async (db) => {
        await migrate(db, command === "status");
        if (command === "status") return indexStatus(db);
        const result = await indexNotes(db, config, command === "rebuild");
        if (result.some((scope) => scope.errors.length)) process.exitCode = 1;
        if (embedder)
          await embedPending(db, embedder).catch((error: Error) => {
            embedFailure = error.message;
          });
        return result;
      },
    );
    console.log(JSON.stringify(output, null, 2));
    if (embedFailure) {
      // Keyword indexing committed; embeddings resume on the next run.
      console.error(`Embeddings not updated: ${embedFailure}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
