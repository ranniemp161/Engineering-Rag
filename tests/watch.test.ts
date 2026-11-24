import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig } from "../src/config/load-config.ts";
import {
  type WatchEvent,
  watchNotes,
} from "../src/indexing/watch-service.ts";
import { readIndex } from "./index-access.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  const project = path.join(dir, "project");
  await mkdir(shared);
  const configFile = path.join(dir, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      databasePath: path.join(dir, "index", "index.db"),
      scopes: [
        { id: "shared", displayName: "Shared", type: "shared", rootPath: shared },
        { id: "pilot", displayName: "Pilot", type: "project", rootPath: project },
      ],
    }),
  );
  const config = await loadConfig(configFile, { allowUnavailableRoots: true });
  const paths = (term: string) =>
    readIndex(config.databasePath, async ({ db }) =>
      (
        await db.all(
          `SELECT DISTINCT d.scope_id || ':' || d.relative_path AS key FROM chunks c
           JOIN documents d ON d.id = c.document_id WHERE fts_match(c.content, ?1)`,
          term,
        )
      ).map((row) => row.key as string),
    ).catch(() => [] as string[]);
  return { dir, shared, project, config, configFile, paths };
}

async function until(check: () => Promise<boolean> | boolean, what: string) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

test("watch applies note changes, ignores excluded and non-Markdown files, debounces bursts and recovers", async (t) => {
  const { shared, project, config, paths } = await fixture(t);
  await writeFile(path.join(shared, "alpha.md"), "# Alpha\nalphaterm\n");
  const events: WatchEvent[] = [];
  const stop = new AbortController();
  const scans = () =>
    events.filter(
      (e): e is Extract<WatchEvent, { event: "scan" }> => e.event === "scan",
    );
  const running = watchNotes(config, {
    signal: stop.signal,
    report: (event) => events.push(event),
    debounceMs: 150,
    maxWaitMs: 2000,
    reconcileMs: 0,
    retryMs: 200,
  });
  t.after(async () => {
    stop.abort();
    await running;
  });

  // Startup indexes existing notes; the missing project root reports and retries.
  await until(() => scans().some((e) => e.reason === "startup"), "startup scan");
  assert.deepEqual(await paths("alphaterm"), ["shared:alpha.md"]);
  assert.ok(
    events.some((e) => e.event === "watch-error" && e.scope === "pilot"),
  );

  // Create in a new subdirectory, then edit and delete.
  await mkdir(path.join(shared, "sub"));
  await writeFile(path.join(shared, "sub", "beta.md"), "betaterm");
  await until(
    async () => (await paths("betaterm")).length === 1,
    "new note to be indexed",
  );
  await writeFile(path.join(shared, "alpha.md"), "# Alpha\ngammaterm\n");
  await until(
    async () => (await paths("gammaterm")).length === 1,
    "edited note to be reindexed",
  );
  assert.deepEqual(await paths("alphaterm"), []);
  await rm(path.join(shared, "alpha.md"));
  await until(
    async () => (await paths("gammaterm")).length === 0,
    "deleted note to be removed",
  );

  // Excluded folders and non-Markdown files do not trigger rescans.
  await delay(400);
  let before = scans().length;
  await mkdir(path.join(shared, ".obsidian"));
  await writeFile(path.join(shared, ".obsidian", "hidden.md"), "hiddenterm");
  await writeFile(path.join(shared, "code.ts"), "export const x = 1;");
  await delay(600);
  assert.equal(scans().length, before);
  assert.deepEqual(await paths("hiddenterm"), []);

  // A burst of edits produces one rescan.
  before = scans().length;
  for (let i = 0; i < 8; i++)
    await writeFile(path.join(shared, `burst-${i}.md`), `burstterm ${i}`);
  await until(
    async () => (await paths("burstterm")).length === 8,
    "burst to be indexed",
  );
  await delay(400);
  assert.equal(scans().length - before, 1);

  // A busy index is retried after the lock is released.
  await readIndex(config.databasePath, async () => {
    await writeFile(path.join(shared, "locked.md"), "lockedterm");
    await until(() => events.some((e) => e.event === "busy"), "busy report");
  });
  await until(
    async () => (await paths("lockedterm")).length === 1,
    "busy change to be retried",
  );

  // A root that appears later is attached and scanned without a restart.
  await mkdir(project);
  await writeFile(path.join(project, "decision.md"), "pilotterm");
  await until(
    async () => (await paths("pilotterm")).length === 1,
    "recovered root to be indexed",
  );
  assert.ok(
    events.some((e) => e.event === "watching" && e.scope === "pilot"),
  );
  assert.ok(scans().some((e) => e.reason === "recovered"));

  stop.abort();
  await running;
  assert.deepEqual(events.at(-1), { event: "stopped" });
});

test("reconcile rescans every scope and follows a replaced root by path", async (t) => {
  const { dir, shared, config, paths } = await fixture(t);
  await writeFile(path.join(shared, "note.md"), "steadyterm");
  const events: WatchEvent[] = [];
  const stop = new AbortController();
  const running = watchNotes(config, {
    signal: stop.signal,
    report: (event) => events.push(event),
    reconcileMs: 300,
    retryMs: 200,
  });
  t.after(async () => {
    stop.abort();
    await running;
  });
  await until(
    () =>
      events.some(
        (e) =>
          e.event === "scan" &&
          e.reason === "reconcile" &&
          e.results.some((r) => r.scope === "shared" && r.unchanged === 1),
      ),
    "reconcile scan",
  );
  assert.equal(
    events.filter((e) => e.event === "watching" && e.scope === "shared").length,
    1,
  );

  // Moving the root away keeps the last valid entries.
  await rename(shared, path.join(dir, "moved"));
  await until(
    () =>
      events.some(
        (e) =>
          e.event === "scan" &&
          e.results.some((r) =>
            r.errors.some((x) => x.code === "DIRECTORY_UNAVAILABLE"),
          ),
      ),
    "unavailable root to be recorded",
  );
  assert.deepEqual(await paths("steadyterm"), ["shared:note.md"]);

  // A new directory at the configured path replaces the old content.
  await mkdir(shared);
  await writeFile(path.join(shared, "fresh.md"), "freshterm");
  await until(
    async () =>
      (await paths("freshterm")).length === 1 &&
      (await paths("steadyterm")).length === 0,
    "replacement root to be indexed",
  );
  await writeFile(path.join(shared, "later.md"), "laterterm");
  await until(
    async () => (await paths("laterterm")).length === 1,
    "change in the replacement root",
  );
});

test("CLI watch streams JSON lines and stops cleanly", async (t) => {
  const { shared, configFile, paths } = await fixture(t);
  const child = spawn(
    process.execPath,
    ["src/cli.ts", "watch", "--debounce", "100", "--reconcile", "0"],
    {
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: configFile },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  t.after(() => {
    child.kill();
  });
  await until(() => stdout.includes('"reason":"startup"'), "CLI startup");
  await writeFile(path.join(shared, "cli.md"), "cliterm");
  await until(
    async () => (await paths("cliterm")).length === 1,
    "CLI change to be indexed",
  );
  const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.every((line) => typeof line.at === "string" && line.event));
  assert.ok(lines.some((line) => line.event === "scan" && line.reason === "change"));
  child.kill(process.platform === "win32" ? undefined : "SIGINT");
  const code = await exited;
  if (process.platform !== "win32") {
    assert.equal(code, 0, stderr);
    assert.match(stdout, /"event":"stopped"/);
  }
  assert.equal(stderr, "");
});

test("CLI watch stops cleanly when its launcher's stdin closes", async (t) => {
  const { configFile } = await fixture(t);
  const child = spawn(
    process.execPath,
    [
      "src/cli.ts",
      "watch",
      "--reconcile",
      "0",
      "--no-code",
      "--stop-on-stdin-close",
    ],
    {
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: configFile },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => resolve(code)),
  );
  t.after(() => {
    child.kill();
  });
  await until(() => stdout.includes('"reason":"startup"'), "CLI startup");
  child.stdin.end();
  assert.equal(await exited, 0, stderr);
  assert.match(stdout, /"event":"stopped"/);
  assert.equal(stderr, "");
});
