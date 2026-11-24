import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startCodeGraphRefresh, type CodeWatchEvent } from "../src/code/code-watch.ts";
import { loadConfig } from "../src/config/load-config.ts";
import { type WatchEvent, watchNotes } from "../src/indexing/watch-service.ts";
import { fakeGraphify } from "./fake-graphify.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, extra: object = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-codewatch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repository = path.join(dir, "repo");
  const notes = path.join(dir, "notes");
  for (const d of [path.join(repository, "src"), path.join(repository, "node_modules", "x"), notes, path.join(dir, "shared")])
    await mkdir(d, { recursive: true });
  const configFile = path.join(dir, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      databasePath: path.join(dir, "index.db"),
      scopes: [
        { id: "shared", displayName: "Shared", type: "shared", rootPath: path.join(dir, "shared") },
        {
          id: "pilot",
          displayName: "Pilot",
          type: "project",
          rootPath: notes,
          codeGraph: { repository, output: path.join(dir, "graph"), ...extra },
        },
      ],
    }),
  );
  return { dir, repository, notes, config: await loadConfig(configFile) };
}

async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

test("code refresh rebuilds once per burst of source edits and ignores other files", async (t) => {
  const { repository, config } = await fixture(t);
  const builds: string[] = [];
  const events: CodeWatchEvent[] = [];
  let release: (() => void) | undefined;
  const refresh = startCodeGraphRefresh(config, {
    report: (e) => events.push(e),
    debounceMs: 150,
    maxWaitMs: 5000,
    build: async (projectId) => {
      builds.push(projectId);
      if (builds.length === 3) await new Promise<void>((r) => (release = r));
      return { projectId, nodes: 1, links: 0, visualized: false, seconds: 0 };
    },
  });
  t.after(() => refresh.stop());
  assert.deepEqual(refresh.projects, ["pilot"]);
  await until(() => builds.length === 1, "startup build");
  assert.ok(events.some((e) => e.event === "code-watching"));
  const graphs = () => events.filter((e) => e.event === "code-graph");
  await until(() => graphs().length === 1, "startup report");
  assert.equal((graphs()[0] as { reason: string }).reason, "startup");

  // Notes, other file types and excluded folders never trigger a rebuild.
  await writeFile(path.join(repository, "README.md"), "# notes");
  await writeFile(path.join(repository, "data.json"), "{}");
  await writeFile(path.join(repository, "node_modules", "x", "index.js"), "x");
  await delay(500);
  assert.equal(builds.length, 1);

  // A burst of source edits costs one rebuild.
  for (let i = 0; i < 5; i++) await writeFile(path.join(repository, "src", `f${i}.ts`), `export const v${i} = ${i};`);
  await until(() => builds.length === 2, "rebuild after burst");
  await delay(400);
  assert.equal(builds.length, 2);
  assert.equal((graphs().at(-1) as { reason: string }).reason, "change");

  // An edit during a build queues exactly one more build after it.
  await writeFile(path.join(repository, "src", "slow.py"), "x = 1");
  await until(() => builds.length === 3 && release !== undefined, "third build to start");
  await writeFile(path.join(repository, "src", "during.go"), "package main");
  await writeFile(path.join(repository, "src", "during2.go"), "package main");
  await delay(400);
  assert.equal(builds.length, 3);
  release?.();
  await until(() => builds.length === 4, "queued build after the running one");
  await delay(400);
  assert.equal(builds.length, 4);

  refresh.reconcile();
  await until(() => builds.length === 5, "reconcile build");
  assert.equal((graphs().at(-1) as { reason: string }).reason, "reconcile");
});

test("a failed build is reported and the next change retries", async (t) => {
  const { repository, config } = await fixture(t);
  let fail = true;
  let builds = 0;
  const events: CodeWatchEvent[] = [];
  const refresh = startCodeGraphRefresh(config, {
    report: (e) => events.push(e),
    debounceMs: 100,
    build: async (projectId) => {
      builds++;
      if (fail) throw new Error("Graphify was not found. Install it or set GRAPHIFY_COMMAND.");
      return { projectId, nodes: 1, links: 0, visualized: false, seconds: 0 };
    },
  });
  t.after(() => refresh.stop());
  await until(
    () => events.some((e) => e.event === "error" && /Code graph not updated: Graphify was not found/.test(e.message)),
    "failure report",
  );
  await delay(400);
  assert.equal(builds, 1);
  fail = false;
  await writeFile(path.join(repository, "src", "a.ts"), "export {}");
  await until(() => events.some((e) => e.event === "code-graph"), "retry on next change");
});

test("watch refreshes notes and the code graph together, visualizing when configured", async (t) => {
  const { dir, repository, notes, config } = await fixture(t, { visualize: true });
  const fake = await fakeGraphify(dir);
  // The real build runs the fake Graphify script through Node.
  const { buildCodeGraph } = await import("../src/code/build-graph.ts");
  const events: WatchEvent[] = [];
  const stop = new AbortController();
  const running = watchNotes(config, {
    signal: stop.signal,
    report: (e) => events.push(e),
    debounceMs: 100,
    reconcileMs: 0,
    codeDebounceMs: 150,
    codeBuild: (projectId) =>
      buildCodeGraph(config, projectId, { runner: { command: process.execPath, prefixArgs: [fake] } }),
  });
  try {
    const codeGraphs = () => events.filter((e) => e.event === "code-graph");
    await until(() => codeGraphs().length === 1, "startup code graph");
    await writeFile(path.join(notes, "decision.md"), "# Decision\n");
    await writeFile(path.join(repository, "src", "stock.ts"), "export const x = 1;");
    await until(
      () => codeGraphs().length === 2 && events.some((e) => e.event === "scan" && e.reason === "change"),
      "note scan and code rebuild",
    );
    const last = codeGraphs().at(-1) as Extract<WatchEvent, { event: "code-graph" }>;
    assert.equal(last.result.visualized, true);
    const calls = (await readFile(path.join(dir, "graph", "calls.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).argv[0]);
    assert.deepEqual(calls, ["update", "cluster-only", "tree", "update", "cluster-only", "tree"]);
  } finally {
    stop.abort();
    await running;
  }
  assert.deepEqual(events.at(-1), { event: "stopped" });
});
