import { buildCodeGraph } from "./code/build-graph.ts";
import { getCodeImpact, searchCodeGraph } from "./code/code-graph.ts";
import { loadConfig } from "./config/load-config.ts";
import { indexNotes, indexStatus } from "./indexing/index-service.ts";
import { watchNotes } from "./indexing/watch-service.ts";
import { withReadSession, withWriteSession } from "./storage/index-session.ts";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  compareReports,
  loadEvalCases,
  readReport,
  runEvaluation,
} from "./evaluation/evaluate.ts";
import { parseArgs } from "node:util";
import { getRelatedDocuments } from "./retrieval/related.ts";
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
    (![
      "search",
      "watch",
      "eval",
      "related",
      "code-build",
      "code-search",
      "code-impact",
    ].includes(command ?? "") &&
      args.length !== 1) ||
    ![
      "index",
      "rebuild",
      "status",
      "search",
      "watch",
      "eval",
      "fetch-model",
      "related",
      "code-build",
      "code-search",
      "code-impact",
    ].includes(command ?? "")
  )
    throw new Error(
      'Usage: pnpm dev -- index|status|rebuild|fetch-model, search "keywords" [--project ID] [--limit N] [--mode keyword|hybrid] [--json], related DOCUMENT_ID [--project ID] [--limit N], code-build [--project ID], code-search "name" --project ID [--limit N], code-impact NODE_ID --project ID [--direction dependents|dependencies] [--depth N] [--limit N],watch [--debounce MS] [--reconcile MINUTES], or eval [--file CASES] [--baseline REPORT] [--output REPORT] [--mode keyword|hybrid]',
    );
  const config = await loadConfig(undefined, { allowUnavailableRoots: true });
  if (command === "code-build") {
    const { values } = parseArgs({
      args: rest,
      options: { project: { type: "string" }, visualize: { type: "boolean" } },
    });
    const projects = values.project
      ? [values.project]
      : config.scopes.filter((s) => s.codeGraph).map((s) => s.id);
    if (!projects.length) throw new Error("No project configures a codeGraph");
    const results = [];
    // --visualize forces the HTML views; otherwise each project's config decides.
    for (const id of projects)
      results.push(
        await buildCodeGraph(config, id, values.visualize ? { visualize: true } : {}),
      );
    console.log(JSON.stringify(results, null, 2));
  } else if (command === "code-search") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { project: { type: "string" }, limit: { type: "string" } },
    });
    if (positionals.length !== 1) throw new Error("Supply one name to search for");
    const output = await searchCodeGraph(config, {
      query: positionals[0],
      projectId: values.project,
      limit: values.limit === undefined ? undefined : Number(values.limit),
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (command === "code-impact") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        project: { type: "string" },
        direction: { type: "string" },
        depth: { type: "string" },
        limit: { type: "string" },
      },
    });
    if (positionals.length !== 1) throw new Error("Supply one node ID from code-search");
    const number = (value: string | undefined) =>
      value === undefined ? undefined : Number(value);
    const output = await getCodeImpact(config, {
      nodeId: positionals[0],
      projectId: values.project,
      direction: values.direction,
      depth: number(values.depth),
      limit: number(values.limit),
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (command === "related") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { project: { type: "string" }, limit: { type: "string" } },
    });
    if (positionals.length !== 1)
      throw new Error("Supply one document ID from a search result");
    const output = await getRelatedDocuments(config, {
      documentId: positionals[0],
      projectId: values.project,
      limit: values.limit === undefined ? undefined : Number(values.limit),
    });
    console.log(JSON.stringify(output, null, 2));
  } else if (command === "fetch-model") {
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
        "code-debounce": { type: "string", default: "10000" },
        "no-code": { type: "boolean" },
        "stop-on-stdin-close": { type: "boolean" },
      },
    });
    const codeDebounceMs = Number(values["code-debounce"]);
    if (!Number.isInteger(codeDebounceMs) || codeDebounceMs < 500 || codeDebounceMs > 600_000)
      throw new Error("--code-debounce must be 500 to 600000 milliseconds");
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
    // A launcher's console or pipe closing means the launcher is gone. On
    // Windows, stopping a scheduled task kills only its top process, so this
    // is how the watcher learns to stop instead of running orphaned.
    if (values["stop-on-stdin-close"]) {
      const onClose = () => stop.abort();
      process.stdin.once("end", onClose);
      process.stdin.once("close", onClose);
      process.stdin.once("error", onClose);
      process.stdin.resume();
    }
    // One JSON object per line so logs can be followed and parsed.
    await watchNotes(config, {
      signal: stop.signal,
      debounceMs,
      reconcileMs: reconcileMinutes * 60_000,
      code: !values["no-code"],
      codeDebounceMs,
      report: (event) =>
        console.log(JSON.stringify({ at: new Date().toISOString(), ...event })),
    });
    // A still-open stdin would keep the process alive after a signal stop.
    if (values["stop-on-stdin-close"]) process.stdin.destroy();
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
  } else if (command === "status") {
    const output = await withReadSession(config, [], indexStatus, {
      whenMissing: () => ({ initialized: false, scopes: [] }),
    });
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Load the model before taking the index guard; failure does not block indexing.
    let embedder: Embedder | undefined;
    let embedFailure: string | undefined;
    if (config.semantic)
      embedder = await getEmbedder(config.semantic).catch((error: Error) => {
        embedFailure = error.message;
        return undefined;
      });
    const rebuild = command === "rebuild";
    const output = await withWriteSession(
      config,
      config.scopes.map((scope) => scope.id),
      async (session) => {
        const { db } = session;
        const result = await indexNotes(session, config);
        if (result.some((scope) => scope.errors.length)) process.exitCode = 1;
        if (embedder)
          await embedPending(db, embedder).catch((error: Error) => {
            embedFailure = error.message;
          });
        return result;
      },
      { rebuild },
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
