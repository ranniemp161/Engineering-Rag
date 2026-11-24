import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config/load-config.ts";
import { searchKnowledge } from "../src/retrieval/search-service.ts";
import { UnknownScopeError } from "../src/storage/index-session.ts";

test("ranked CLI search enforces project boundaries before limiting and cites literal source", async (t) => {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "engineering-search-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const scopes = ["shared", "a", "b"].map((id) => ({
    id,
    type: id === "shared" ? "shared" : "project",
    displayName: id,
    rootPath: path.join(dir, id),
  }));
  const configFile = path.join(dir, "config.json");
  const databasePath = path.join(dir, "index.db");
  const notes = [
    "# Handbook\r\n" +
      "ordinary reference material ".repeat(20) +
      "\r\nAudit the log.",
    "---\r\ntitle: Inventory policy\r\n---\r\n# Operations\r\nAudit audit inventory.",
    `# Review\r\n${"audit ".repeat(30)}`,
  ];
  for (const [i, s] of scopes.entries()) {
    await mkdir(s.rootPath);
    await writeFile(path.join(s.rootPath, "guide.md"), notes[i] ?? "");
  }
  await writeFile(
    configFile,
    JSON.stringify({
      databasePath,
      scopes,
      search: { defaultLimit: 2, maxLimit: 3 },
    }),
  );
  const config = await loadConfig(configFile);
  const cli = (args: string[], expected = 0) => {
    const run = spawnSync(process.execPath, ["src/cli.ts", ...args], {
      encoding: "utf8",
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: configFile },
    });
    assert.equal(run.status, expected, run.stderr);
    return run;
  };
  await assert.rejects(
    searchKnowledge(config, { query: "audit" }),
    /Index missing/,
  );
  cli(["index"]);
  const ranked = await searchKnowledge(config, {
    query: "audit",
    projectId: "a",
  });
  assert.deepEqual(
    ranked.results.map((r) => r.scope),
    ["a", "shared"],
  );
  // The shared scope named as a project reads shared knowledge only.
  const sharedOnly = await searchKnowledge(config, { query: "audit", projectId: "shared" });
  assert.deepEqual([...new Set(sharedOnly.results.map((r) => r.scope))], ["shared"]);
  await assert.rejects(
    searchKnowledge(config, { query: "audit", projectId: "missing" }),
    (error) => error instanceof UnknownScopeError && error.message === "Unknown project ID",
  );
  const strongest = await searchKnowledge(config, {
    query: "audit",
    projectId: "b",
    limit: 1,
  });
  assert.ok(
    strongest.results[0] &&
      ranked.results[0] &&
      strongest.results[0].score > ranked.results[0].score,
  );
  const one = JSON.parse(
    cli(["search", "audit", "--project", "a", "--limit", "1", "--json"]).stdout,
  );
  assert.deepEqual(one.results, ranked.results.slice(0, 1));
  const shared = JSON.parse(cli(["search", "audit"]).stdout);
  assert.deepEqual(
    shared.results.map((r: { scope: string }) => r.scope),
    ["shared"],
  );
  for (const r of ranked.results) {
    const text = await readFile(
      path.join(dir, r.scope, r.relativePath),
      "utf8",
    );
    assert.ok(
      text
        .split(/\r?\n/)
        .slice(r.startLine - 1, r.endLine)
        .join("\n")
        .includes(r.snippet),
    );
    assert.match(r.snippet, /audit/i);
    assert.ok(r.snippet.length <= 400 && r.score > 0);
    assert.equal(r.relativePath, "guide.md");
  }
  assert.equal(ranked.results[0]?.title, "Inventory policy");
  assert.deepEqual(
    (await searchKnowledge(config, { query: "absentword" })).results,
    [],
  );
  const punctuated = await searchKnowledge(config, {
    query: '"audit:(inventory*',
    projectId: "a",
  });
  assert.ok(punctuated.results.some((r) => r.scope === "a"));
  for (const input of [
    { query: "" },
    { query: "!!!" },
    { query: "a".repeat(513) },
    { query: "audit", projectId: "unknown" },
    { query: "x", limit: 4 },
    { query: "x", limit: 1.5 },
  ]) {
    await assert.rejects(searchKnowledge(config, input));
  }
  assert.equal(cli(["search", "audit", "--limit", "bogus"], 1).stdout, "");
  const remapped = {
    ...config,
    scopes: config.scopes.map((s) =>
      s.id === "shared" ? { ...s, rootPath: path.join(dir, "replacement") } : s,
    ),
  };
  await assert.rejects(
    searchKnowledge(remapped, { query: "audit" }),
    /Rebuild/,
  );
  const wrap = [
    ...Array<string>(12).fill("x".repeat(125)),
    "overlapmarker",
    "y".repeat(150),
    "z".repeat(150),
  ].join("\n");
  await writeFile(path.join(dir, "shared", "wrapped.md"), wrap);
  cli(["index"]);
  const overlap = await searchKnowledge(config, { query: "overlapmarker" });
  assert.equal(overlap.results.length, 1);
  assert.match(overlap.results[0]?.snippet ?? "", /overlapmarker/);
});
