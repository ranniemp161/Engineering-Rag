import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { loadConfig } from "../src/config/load-config.ts";
import { refreshIndex } from "../src/indexing/index-service.ts";
import { searchKnowledge } from "../src/retrieval/search-service.ts";
import type { Embedder } from "../src/semantic/embedder.ts";
import { IndexBusyError } from "../src/storage/index-session.ts";
import { fakeEmbedder } from "./fake-embedder.ts";
import { readIndex } from "./index-access.ts";

async function fixture(t: TestContext, semantic?: object) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-refresh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = { shared: path.join(dir, "shared"), pilot: path.join(dir, "pilot") };
  for (const root of Object.values(roots)) await mkdir(root);
  await writeFile(path.join(roots.shared, "backups.md"), "# Backups\nBackups run daily.\n");
  await writeFile(path.join(roots.pilot, "hosting.md"), "# Hosting\nThe server runs in Singapore.\n");
  const configFile = path.join(dir, "config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      databasePath: path.join(dir, "index.db"),
      scopes: [
        { id: "shared", displayName: "Shared", type: "shared", rootPath: roots.shared },
        { id: "pilot", displayName: "Pilot", type: "project", rootPath: roots.pilot },
      ],
      ...(semantic ? { semantic } : {}),
    }),
  );
  const config = await loadConfig(configFile, { allowUnavailableRoots: true });
  const documents = () =>
    readIndex(config.databasePath, async ({ db }) =>
      (await db.all("SELECT scope_id || ':' || relative_path AS key FROM documents ORDER BY key")).map(
        (row) => row.key as string,
      ),
    );
  return { dir, roots, config, documents };
}

test("refreshing named scopes scans only those scopes", async (t) => {
  const { config, documents } = await fixture(t);
  const result = await refreshIndex(config, { kind: "scopes", ids: ["pilot"] });
  assert.deepEqual(
    result.scans.map((scan) => [scan.scope, scan.updated]),
    [["pilot", 1]],
  );
  assert.deepEqual(await documents(), ["pilot:hosting.md"]);
  assert.deepEqual(result.embedding, { status: "off" });
});

test("a rebuild replaces every scope", async (t) => {
  const { roots, config, documents } = await fixture(t);
  await refreshIndex(config, { kind: "all" });
  await rm(path.join(roots.shared, "backups.md"));
  await writeFile(path.join(roots.shared, "restores.md"), "# Restores\nRestore weekly.\n");
  const result = await refreshIndex(config, { kind: "rebuild" });
  assert.deepEqual(result.scans.map((scan) => scan.scope), ["shared", "pilot"]);
  assert.deepEqual(await documents(), ["pilot:hosting.md", "shared:restores.md"]);
});

test("a configured embedder embeds every new passage", async (t) => {
  const { config } = await fixture(t, { modelDir: "./models" });
  const { embedder } = fakeEmbedder();
  const result = await refreshIndex(config, { kind: "all" }, { embedder });
  assert.deepEqual(result.embedding, {
    status: "updated",
    model: "fake-model",
    embedded: 2,
    removedStale: 0,
    chunks: 2,
    vectors: 2,
  });
});

test("a model that cannot load leaves keyword indexing working", async (t) => {
  const { config } = await fixture(t, { modelDir: "./models" });
  const result = await refreshIndex(config, { kind: "all" });
  assert.equal(result.embedding.status, "failed");
  assert.ok(result.embedding.status === "failed" && result.embedding.stage === "model");
  assert.match(result.embedding.message, /not available offline/);
  const found = await searchKnowledge(config, { query: "Singapore", projectId: "pilot" }, { mode: "keyword" });
  assert.deepEqual(found.results.map((r) => r.relativePath), ["hosting.md"]);
});

test("an embedder that fails mid-run keeps the committed scan", async (t) => {
  const { config, documents } = await fixture(t, { modelDir: "./models" });
  const broken: Embedder = {
    model: "broken",
    embed: async () => {
      throw new Error("embedder crashed");
    },
  };
  const result = await refreshIndex(config, { kind: "all" }, { embedder: broken });
  assert.deepEqual(result.embedding, { status: "failed", stage: "embed", message: "embedder crashed" });
  assert.deepEqual(await documents(), ["pilot:hosting.md", "shared:backups.md"]);
});

test("a busy index is reported to the caller", async (t) => {
  const { config } = await fixture(t);
  await refreshIndex(config, { kind: "all" });
  await readIndex(config.databasePath, async () => {
    await assert.rejects(refreshIndex(config, { kind: "all" }), IndexBusyError);
  });
});
