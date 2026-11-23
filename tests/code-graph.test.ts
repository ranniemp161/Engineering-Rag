import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { buildCodeGraph } from "../src/code/build-graph.ts";
import { getCodeImpact, searchCodeGraph } from "../src/code/code-graph.ts";
import { loadConfig } from "../src/config/load-config.ts";

// Mirrors graph.json from graphifyy 0.9.97 `update --no-cluster` on a three-file
// TypeScript fixture (checkout.ts -> stock.ts -> math.ts), recorded 2026-11-24.
function fixtureGraph(repository: string) {
  const node = (id: string, label: string, file: string, line: number) => ({
    id,
    label,
    file_type: "code",
    source_file: file,
    source_location: `L${line}`,
  });
  const link = (
    source: string,
    target: string,
    relation: string,
    file: string,
    line: number,
    confidence = "EXTRACTED",
  ) => ({ source, target, relation, confidence, source_file: file, source_location: `L${line}` });
  return {
    directed: false,
    nodes: [
      node("src_checkout", "checkout.ts", "src/checkout.ts", 1),
      node("src_checkout_checkout", "checkout()", "src/checkout.ts", 3),
      node("src_math", "math.ts", "src/math.ts", 1),
      node("src_math_clamp", "clamp()", "src/math.ts", 1),
      node("src_stock", "stock.ts", "src/stock.ts", 1),
      node("src_stock_stocklevel", "StockLevel", "src/stock.ts", 3),
      node("src_stock_applysale", "applySale()", "src/stock.ts", 7),
      node("src_stock_inventory", "Inventory", "src/stock.ts", 11),
      node("src_stock_inventory_sell", ".sell()", "src/stock.ts", 13),
      // Absolute paths: inside the repository becomes relative, outside is hidden.
      node("abs_inside", "insideAbs()", path.join(repository, "src", "abs.ts"), 2),
      node("abs_outside", "outsideAbs()", path.join(path.dirname(repository), "secret.ts"), 4),
    ],
    links: [
      link("src_checkout", "src_stock", "imports_from", "src/checkout.ts", 1),
      link("src_checkout", "src_stock_inventory", "imports", "src/checkout.ts", 1),
      link("src_checkout", "src_checkout_checkout", "contains", "src/checkout.ts", 3),
      link("src_math", "src_math_clamp", "contains", "src/math.ts", 1),
      link("src_stock", "src_math", "imports_from", "src/stock.ts", 1),
      link("src_stock", "src_math_clamp", "imports", "src/stock.ts", 1),
      link("src_stock", "src_stock_stocklevel", "contains", "src/stock.ts", 3),
      link("src_stock", "src_stock_applysale", "contains", "src/stock.ts", 7),
      link("src_stock", "src_stock_inventory", "contains", "src/stock.ts", 11),
      link("src_stock_inventory", "src_stock_inventory_sell", "method", "src/stock.ts", 13),
      link("src_stock_inventory_sell", "src_stock_applysale", "calls", "src/stock.ts", 15),
      link("src_stock_applysale", "src_math_clamp", "calls", "src/stock.ts", 8),
      link("src_checkout_checkout", "src_stock_inventory_sell", "calls", "src/checkout.ts", 4, "INFERRED"),
      link("missing_node", "src_math_clamp", "calls", "src/x.ts", 1),
    ],
  };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-code-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "notes", "shared");
  const pilotNotes = path.join(dir, "notes", "pilot");
  const repository = path.join(dir, "repo");
  const output = path.join(dir, "graphs", "pilot");
  for (const d of [shared, pilotNotes, path.join(repository, "src"), output])
    await mkdir(d, { recursive: true });
  const configFile = path.join(dir, "config.json");
  const raw = {
    databasePath: path.join(dir, "index.db"),
    scopes: [
      { id: "shared", displayName: "Shared", type: "shared", rootPath: shared },
      {
        id: "pilot",
        displayName: "Pilot",
        type: "project",
        rootPath: pilotNotes,
        repositories: [repository],
        codeGraph: { output: "./graphs/pilot" },
      },
      { id: "plain", displayName: "Plain", type: "project", rootPath: path.join(dir, "notes", "plain") },
    ],
  };
  await mkdir(path.join(dir, "notes", "plain"));
  await writeFile(configFile, JSON.stringify(raw));
  const config = await loadConfig(configFile);
  return { dir, repository, output, configFile, raw, config };
}

test("code search ranks exact names, splits identifiers and keeps paths repository-relative", async (t) => {
  const { repository, output, config } = await fixture(t);
  await assert.rejects(
    searchCodeGraph(config, { query: "clamp", projectId: "pilot" }),
    /Run the code-build command/,
  );
  await writeFile(path.join(output, "graph.json"), JSON.stringify(fixtureGraph(repository)));
  const exact = await searchCodeGraph(config, { query: "applySale", projectId: "pilot" });
  assert.deepEqual(exact.results[0], {
    nodeId: "src_stock_applysale",
    label: "applySale()",
    kind: "function",
    path: "src/stock.ts",
    line: 7,
    dependents: 2,
    dependencies: 1,
    score: 16,
  });
  // "sale" matches applySale by its split words; the file node ranks below.
  assert.equal(
    (await searchCodeGraph(config, { query: "sale", projectId: "pilot" })).results[0]?.nodeId,
    "src_stock_applysale",
  );
  const sell = await searchCodeGraph(config, { query: "sell", projectId: "pilot" });
  assert.equal(sell.results[0]?.kind, "method");
  const files = await searchCodeGraph(config, { query: "stock.ts", projectId: "pilot" });
  assert.equal(files.results[0]?.kind, "file");
  const inside = await searchCodeGraph(config, { query: "insideAbs", projectId: "pilot" });
  assert.equal(inside.results[0]?.path, "src/abs.ts");
  const outside = await searchCodeGraph(config, { query: "outsideAbs", projectId: "pilot" });
  assert.equal(outside.results[0]?.path, null);
  assert.ok(!JSON.stringify(outside).includes(path.dirname(repository)));

  await assert.rejects(searchCodeGraph(config, { query: "clamp" }), /need a projectId/);
  await assert.rejects(
    searchCodeGraph(config, { query: "clamp", projectId: "plain" }),
    /No code graph is configured/,
  );
  await assert.rejects(
    searchCodeGraph(config, { query: "clamp", projectId: "nope" }),
    /Unknown project ID/,
  );
});

test("code impact follows Graphify's affected relations in both directions", async (t) => {
  const { repository, output, config } = await fixture(t);
  await writeFile(path.join(output, "graph.json"), JSON.stringify(fixtureGraph(repository)));
  const impact = (nodeId: string, extra: Record<string, unknown> = {}) =>
    getCodeImpact(config, { nodeId, projectId: "pilot", ...extra });
  const summarize = (r: Awaited<ReturnType<typeof impact>>) =>
    r.results.map((h) => `${h.nodeId}@${h.depth}:${h.relation}`);

  // Changing clamp affects its importer and caller, then their dependents.
  const clamp = await impact("src_math_clamp");
  assert.deepEqual(summarize(clamp), [
    "src_stock@1:imports",
    "src_stock_applysale@1:calls",
    "src_checkout@2:imports_from",
    "src_stock_inventory_sell@2:calls",
  ]);
  assert.deepEqual(clamp.results[1]?.via, {
    path: "src/stock.ts",
    line: 8,
    from: "src_stock_applysale",
    to: "src_math_clamp",
  });
  assert.equal((await impact("src_math_clamp", { depth: 1 })).total, 2);

  // A class's methods seed the walk: callers of .sell() count, .sell() itself does not.
  const inventory = await impact("src_stock_inventory");
  assert.deepEqual(summarize(inventory), [
    "src_checkout@1:imports",
    "src_checkout_checkout@1:calls",
  ]);
  assert.equal(inventory.results[1]?.confidence, "INFERRED");

  // Dependencies walk forward; structural contains/method edges are not followed.
  assert.deepEqual(summarize(await impact("src_checkout_checkout", { direction: "dependencies" })), [
    "src_stock_inventory_sell@1:calls",
    "src_stock_applysale@2:calls",
  ]);
  assert.equal((await impact("src_math_clamp", { limit: 1 })).results.length, 1);
  await assert.rejects(impact("nope"), /Unknown code node/);
  await writeFile(path.join(output, "graph.json"), "{not json");
  await assert.rejects(impact("src_math_clamp"), /unreadable/);
});

test("code-build runs graphify update with outputs outside the repository and no LLM keys", async (t) => {
  const { dir, repository, output, config, configFile, raw } = await fixture(t);
  const fake = path.join(dir, "fake-graphify.mjs");
  await writeFile(
    fake,
    `import { writeFileSync } from "node:fs";
import path from "node:path";
const out = process.env.GRAPHIFY_OUT;
if (process.env.FAKE_GRAPHIFY_FAIL) { console.error("boom"); process.exit(3); }
writeFileSync(path.join(out, "graph.json"), JSON.stringify({
  nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "a", target: "b" }],
  argv: process.argv.slice(2), cwd: process.cwd(),
  keys: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY"].filter((k) => process.env[k]),
}));`,
  );
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });
  const before = await readdir(repository, { recursive: true });
  const summary = await buildCodeGraph(config, "pilot", {
    command: process.execPath,
    prefixArgs: [fake],
  });
  assert.equal(summary.nodes, 2);
  assert.equal(summary.links, 1);
  const recorded = JSON.parse(
    await (await import("node:fs/promises")).readFile(path.join(output, "graph.json"), "utf8"),
  );
  assert.deepEqual(recorded.argv, ["update", repository, "--no-cluster"]);
  assert.equal(recorded.cwd, output);
  assert.deepEqual(recorded.keys, []);
  assert.deepEqual(await readdir(repository, { recursive: true }), before);

  process.env.FAKE_GRAPHIFY_FAIL = "1";
  t.after(() => {
    delete process.env.FAKE_GRAPHIFY_FAIL;
  });
  await assert.rejects(
    buildCodeGraph(config, "pilot", { command: process.execPath, prefixArgs: [fake] }),
    /exit 3.*boom/s,
  );
  await assert.rejects(
    buildCodeGraph(config, "pilot", { command: path.join(dir, "no-such-graphify") }),
    /Graphify was not found/,
  );

  // The output directory may not sit in the repository or a source root.
  const reject = async (graph: unknown, message: RegExp) => {
    await writeFile(
      configFile,
      JSON.stringify({
        ...raw,
        scopes: raw.scopes.map((s) => (s.id === "pilot" ? { ...s, codeGraph: graph } : s)),
      }),
    );
    await assert.rejects(loadConfig(configFile), message);
  };
  await reject({ output: path.join(repository, "graphify-out") }, /outside source roots and the repository/);
  await reject({ output: path.join(dir, "notes", "pilot", "graph") }, /outside source roots/);
  await reject({ repository }, /Invalid configuration/);
});
