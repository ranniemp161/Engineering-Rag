import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildIndex } from "./index-access.ts";
import { startViewer } from "./start-viewer.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-eval-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = Object.fromEntries(
    ["shared", "pilot", "other"].map((id) => [id, path.join(dir, id)]),
  ) as Record<"shared" | "pilot" | "other", string>;
  for (const root of Object.values(roots)) await mkdir(root);
  await writeFile(
    path.join(roots.shared, "guide.md"),
    "# Guide\nThe retry policy waits 47 seconds.\n",
  );
  await writeFile(
    path.join(roots.pilot, "decision.md"),
    "# Decision\n\nQueue the inventory adjustment locally.\n",
  );
  await writeFile(path.join(roots.other, "secret.md"), "# Secret\nvaultterm\n");
  const config = path.join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      databasePath: path.join(dir, "index.db"),
      scopes: [
        { id: "shared", displayName: "Shared", type: "shared", rootPath: roots.shared },
        { id: "pilot", displayName: "Pilot", type: "project", rootPath: roots.pilot },
        { id: "other", displayName: "Other", type: "project", rootPath: roots.other },
      ],
    }),
  );
  const cli = (args: string[], exit = 0) => {
    const run = spawnSync(process.execPath, ["src/cli.ts", ...args], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: config },
    });
    assert.equal(run.status, exit, run.stderr + run.stdout);
    return { out: run.stdout ? JSON.parse(run.stdout) : undefined, err: run.stderr };
  };
  await buildIndex(config);
  const cases = path.join(dir, "cases.json");
  const writeCases = (items: unknown[]) =>
    writeFile(cases, JSON.stringify({ cases: items }));
  return { dir, roots, config, cli, cases, writeCases };
}

const standardCases = [
  {
    id: "project-hit",
    query: "queue inventory",
    projectId: "pilot",
    tags: ["keyword"],
    expect: [{ path: "decision.md" }],
  },
  {
    id: "shared-lines-hit",
    query: "47 seconds",
    tags: ["lines"],
    expect: [{ path: "guide.md", lines: [2, 2] }],
  },
  {
    id: "shared-lines-miss",
    query: "47 seconds",
    tags: ["lines"],
    expect: [{ path: "guide.md", lines: [5, 6] }],
  },
  {
    id: "no-results",
    query: "unmatchedterm",
    expect: [{ path: "guide.md" }],
  },
];

test("eval scores ranks, line constraints and groups, and flags regressions against a baseline", async (t) => {
  const { dir, roots, config, cli, cases, writeCases } = await fixture(t);
  await writeCases(standardCases);
  const baseline = path.join(dir, "baseline.json");
  const { out: report } = cli(["eval", "--file", cases, "--output", baseline]);
  const ranks = Object.fromEntries(
    report.cases.map((c: { id: string; rank: number | null }) => [c.id, c.rank]),
  );
  assert.deepEqual(ranks, {
    "project-hit": 1,
    "shared-lines-hit": 1,
    "shared-lines-miss": null,
    "no-results": null,
  });
  assert.equal(report.depth, 20);
  assert.equal(report.file, "cases.json");
  assert.equal(report.comparison, undefined);
  const { latencyP50Ms, latencyP95Ms, ...summary } = report.summary;
  assert.deepEqual(summary, {
    cases: 4,
    hitAt1: 0.5,
    hitAt3: 0.5,
    hitAt5: 0.5,
    hitAtDepth: 0.5,
    mrr: 0.5,
    recallAt5: 0.5,
  });
  assert.ok(latencyP50Ms > 0 && latencyP95Ms >= latencyP50Ms);
  assert.deepEqual(Object.keys(report.byTag), ["keyword", "lines", "untagged"]);
  assert.equal(report.byTag.lines.hitAt1, 0.5);
  assert.deepEqual(Object.keys(report.byProject), ["pilot", "shared"]);
  const hit = report.cases.find((c: { id: string }) => c.id === "project-hit");
  assert.deepEqual(hit.top[0], {
    scope: "pilot",
    path: "decision.md",
    lines: [1, 3],
    score: hit.top[0].score,
  });

  // Removing the passage makes the project case fall out of the top 5.
  await writeFile(path.join(roots.pilot, "decision.md"), "# Decision\nreworded\n");
  await buildIndex(config);
  const { out: after } = cli(["eval", "--file", cases, "--baseline", baseline], 1);
  assert.deepEqual(after.comparison.regressions, [
    { id: "project-hit", before: 1, after: null },
  ]);
  assert.deepEqual(after.comparison.improvements, []);
  assert.equal(after.comparison.delta.hitAt1, -0.25);
  assert.equal(after.comparison.delta.cases, 0);

  // Added and removed cases are listed without counting as regressions.
  await writeCases([
    ...standardCases.slice(1),
    { id: "new-case", query: "reworded", projectId: "pilot", expect: [{ path: "decision.md" }] },
  ]);
  const { out: changed } = cli(["eval", "--file", cases, "--baseline", baseline]);
  assert.deepEqual(changed.comparison.added, ["new-case"]);
  assert.deepEqual(changed.comparison.removed, ["project-hit"]);
  assert.deepEqual(changed.comparison.regressions, []);
});

test("eval rejects invalid or unreachable cases before searching", async (t) => {
  const { cli, cases, writeCases, dir } = await fixture(t);
  const rejects = async (items: unknown[], message: RegExp) => {
    await writeCases(items);
    assert.match(cli(["eval", "--file", cases], 1).err, message);
  };
  const base = { id: "a", query: "vaultterm", expect: [{ path: "secret.md" }] };
  // A project search cannot reach another project's notes.
  await rejects(
    [{ ...base, projectId: "pilot", expect: [{ path: "secret.md", scope: "other" }] }],
    /cannot reach/,
  );
  await rejects([{ ...base, expect: [{ path: "secret.md", scope: "other" }] }], /cannot reach/);
  await rejects([{ ...base, projectId: "missing" }], /unconfigured project/);
  await rejects([base, base], /Duplicate evaluation case/);
  await rejects([{ ...base, expect: [] }], /Invalid evaluation file/);
  await rejects([{ ...base, expect: [{ path: "x.md", lines: [4, 2] }] }], /lines must be/);
  await rejects([{ ...base, extra: true }], /Invalid evaluation file/);
  assert.match(
    cli(["eval", "--file", path.join(dir, "absent.json")], 1).err,
    /Cannot read evaluation cases/,
  );
  await writeCases([{ ...base, projectId: "other" }]);
  assert.match(
    cli(["eval", "--file", cases, "--baseline", path.join(dir, "absent.json")], 1).err,
    /Cannot read baseline report/,
  );
});

test("viewer serves the evaluation report and comparison", async (t) => {
  const { dir, config, cli, cases, writeCases } = await fixture(t);
  await writeCases(standardCases);
  const baseline = path.join(dir, "baseline.json");
  cli(["eval", "--file", cases, "--output", baseline]);
  const viewer = await startViewer(t, config, ["--eval", cases, "--baseline", baseline]);
  const report = await (await fetch(`${viewer.url}/api/eval`)).json();
  assert.equal(report.summary.hitAt1, 0.5);
  assert.deepEqual(report.comparison.regressions, []);
  assert.equal(report.comparison.delta.hitAt1, 0);
  const page = await (await fetch(`${viewer.url}/`)).text();
  assert.match(page, /id="evalBtn"/);
  assert.doesNotMatch(page, /Â|â€/);
});
