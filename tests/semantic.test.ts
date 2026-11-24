import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type Config, loadConfig } from "../src/config/load-config.ts";
import { runEvaluation } from "../src/evaluation/evaluate.ts";
import { indexNotes, indexStatus } from "../src/indexing/index-service.ts";
import { fuseRankings, searchKnowledge } from "../src/retrieval/search-service.ts";
import { embedPending } from "../src/semantic/embed-index.ts";
import { type Embedder, getEmbedder } from "../src/semantic/embedder.ts";
import { withReadSession, withWriteSession } from "../src/storage/index-session.ts";

// Words in one group share a dimension, standing in for learned synonyms.
const CONCEPTS = [
  ["undo", "reverse", "reversal", "reversing", "cancel"],
  ["owe", "debt", "unpaid", "owed"],
  ["hosted", "region", "server", "singapore"],
  ["copied", "backup", "backups", "cloud"],
];

function fakeEmbedder(model = "fake-model") {
  const calls: string[][] = [];
  const embedder: Embedder = {
    model,
    async embed(texts) {
      calls.push(texts);
      return texts.map((text) => {
        const vector = new Float32Array(CONCEPTS.length + 1);
        for (const word of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
          const concept = CONCEPTS.findIndex((group) => group.includes(word));
          const slot = concept < 0 ? CONCEPTS.length : concept;
          vector[slot] = (vector[slot] ?? 0) + (concept < 0 ? 0.05 : 1);
        }
        const norm = Math.hypot(...vector) || 1;
        return vector.map((x) => x / norm);
      });
    },
  };
  return { embedder, calls, texts: () => calls.flat() };
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-semantic-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = Object.fromEntries(
    ["shared", "pilot", "other"].map((id) => [id, path.join(dir, id)]),
  ) as Record<"shared" | "pilot" | "other", string>;
  for (const root of Object.values(roots)) await mkdir(root);
  await writeFile(
    path.join(roots.pilot, "reversal.md"),
    "# Sale reversal\nReversing a sale requires the owner PIN.\n",
  );
  await writeFile(
    path.join(roots.pilot, "hosting.md"),
    "# Hosting\nThe server runs in Singapore.\n",
  );
  await writeFile(
    path.join(roots.shared, "backups.md"),
    "# Backups\nBackups run daily.\n",
  );
  await writeFile(
    path.join(roots.other, "debt.md"),
    "# Debt\nUnpaid debt is written off.\n",
  );
  const configFile = path.join(dir, "config.json");
  const raw = {
    databasePath: path.join(dir, "index.db"),
    scopes: [
      { id: "shared", displayName: "Shared", type: "shared", rootPath: roots.shared },
      { id: "pilot", displayName: "Pilot", type: "project", rootPath: roots.pilot },
      { id: "other", displayName: "Other", type: "project", rootPath: roots.other },
    ],
    semantic: { model: "fake-model", modelDir: path.join(dir, "models") },
  };
  await writeFile(configFile, JSON.stringify(raw));
  const config = await loadConfig(configFile, { allowUnavailableRoots: true });
  const index = (embedder: Embedder) =>
    withWriteSession({ databasePath: config.databasePath, scopes: [] }, [], async ({ db }) => {
      const scans = await indexNotes(db, config, false);
      return { scans, embedding: await embedPending(db, embedder, 2) };
    });
  const search = (
    query: string,
    embedder: Embedder,
    extra: { projectId?: string; mode?: "keyword" | "hybrid" } = {},
  ) =>
    searchKnowledge(
      config,
      { query, projectId: extra.projectId, limit: 5 },
      { embedder, mode: extra.mode },
    ).then((r) => r.results.map((x) => `${x.scope}:${x.relativePath}`));
  return { dir, roots, config, configFile, raw, index, search };
}

test("reciprocal rank fusion rewards agreement and respects weights", () => {
  const item = (chunkId: number) => ({
    chunkId,
    documentId: `d${chunkId}`,
    ordinal: 0,
    row: {},
  });
  const fused = fuseRankings([
    { weight: 1, items: [item(1), item(2), item(3)] },
    { weight: 1, items: [item(3), item(4)] },
  ]);
  assert.deepEqual(
    fused.map((x) => x.chunkId),
    [3, 1, 2, 4],
  );
  assert.equal(fused[0]?.score, 1 / 63 + 1 / 61);
  const keywordOnly = fuseRankings([
    { weight: 1, items: [item(1), item(2)] },
    { weight: 0, items: [item(2), item(1)] },
  ]);
  assert.deepEqual(
    keywordOnly.map((x) => x.chunkId),
    [1, 2],
  );
});

test("hybrid search finds paraphrases, keeps scopes isolated and re-embeds only changes", async (t) => {
  const { roots, config, index, search } = await fixture(t);
  const fake = fakeEmbedder();
  const first = await index(fake.embedder);
  assert.equal(first.embedding.embedded, first.embedding.chunks);
  assert.equal(first.embedding.vectors, first.embedding.chunks);
  assert.ok(fake.calls.every((batch) => batch.length <= 2));
  assert.ok(fake.texts().some((t) => t.startsWith("Sale reversal\nSale reversal\n")));

  // A paraphrase with no shared keyword: keyword search misses, hybrid finds it.
  assert.deepEqual(
    await search("undo purchases", fake.embedder, {
      projectId: "pilot",
      mode: "keyword",
    }),
    [],
  );
  const hybrid = await search("undo purchases", fake.embedder, {
    projectId: "pilot",
  });
  assert.equal(hybrid[0], "pilot:reversal.md");

  // Exact keywords still rank first when both rankings agree.
  assert.equal(
    (await search("Singapore server", fake.embedder, { projectId: "pilot" }))[0],
    "pilot:hosting.md",
  );

  // Another project's notes never appear, even when semantically closest.
  const isolated = await search("customer still owes money", fake.embedder, {
    projectId: "pilot",
  });
  assert.ok(!isolated.some((key) => key.startsWith("other:")));
  assert.equal(
    (await search("customer still owes money", fake.embedder, { projectId: "other" }))[0],
    "other:debt.md",
  );
  // Shared notes are visible from a project search; a shared search excludes projects.
  assert.equal(
    (await search("cloud copies", fake.embedder, { projectId: "pilot" }))[0],
    "shared:backups.md",
  );
  assert.ok(
    (await search("undo purchases", fake.embedder)).every((key) =>
      key.startsWith("shared:"),
    ),
  );

  // Unchanged notes are not embedded again; an edit re-embeds only its chunks.
  fake.calls.length = 0;
  assert.equal((await index(fake.embedder)).embedding.embedded, 0);
  assert.deepEqual(fake.calls, []);
  await writeFile(
    path.join(roots.pilot, "hosting.md"),
    "# Hosting\nThe backend is hosted in a Singapore region.\n",
  );
  const edited = await index(fake.embedder);
  assert.equal(edited.embedding.embedded, 1);
  assert.ok(fake.texts().every((t) => t.startsWith("Hosting")));

  // Deleting a note removes its vectors with its chunks.
  await rm(path.join(roots.pilot, "hosting.md"));
  const removed = await index(fake.embedder);
  assert.equal(removed.embedding.vectors, removed.embedding.chunks);
  const status = await withReadSession({ databasePath: config.databasePath, scopes: [] }, [], indexStatus);
  const pilot = status.scopes.find((s) => s.id === "pilot");
  assert.deepEqual(pilot?.embeddings, { "fake-model": pilot?.chunks });

  // A different model replaces every stored vector.
  const next = fakeEmbedder("fake-model-2");
  const switched = await index(next.embedder);
  assert.equal(switched.embedding.removedStale, removed.embedding.vectors);
  assert.equal(switched.embedding.embedded, switched.embedding.chunks);
});

test("schema 1 indexes stay searchable read-only and upgrade on the next write", async (t) => {
  const { config, index, search } = await fixture(t);
  const fake = fakeEmbedder();
  await index(fake.embedder);
  await withWriteSession({ databasePath: config.databasePath, scopes: [] }, [], async ({ db }) => {
    await db.exec("DROP TABLE chunk_embeddings");
    await db.exec("DROP TABLE document_references");
    await db.exec("UPDATE engineering_index_version SET version = 1");
  });
  // Default mode falls back to keywords; an explicit hybrid request reports why.
  assert.deepEqual(
    await search("Singapore", fake.embedder, { projectId: "pilot" }),
    ["pilot:hosting.md"],
  );
  await assert.rejects(
    search("Singapore", fake.embedder, { projectId: "pilot", mode: "hybrid" }),
    /No embeddings for the configured model/,
  );
  const upgraded = await index(fake.embedder);
  assert.equal(upgraded.embedding.embedded, upgraded.embedding.chunks);
  const version = await withReadSession({ databasePath: config.databasePath, scopes: [] }, [], ({ db }) =>
    db.get("SELECT version FROM engineering_index_version"),
  );
  assert.equal(version?.version, 3);
  assert.equal(
    (await search("undo purchases", fake.embedder, { projectId: "pilot" }))[0],
    "pilot:reversal.md",
  );
});

test("evaluation compares keyword and hybrid modes on the same cases", async (t) => {
  const { dir, config, index } = await fixture(t);
  const fake = fakeEmbedder();
  await index(fake.embedder);
  const cases = [
    { id: "kw", query: "Singapore", projectId: "pilot", tags: ["keyword"], expect: [{ path: "hosting.md" }] },
    { id: "pa", query: "undo purchases", projectId: "pilot", tags: ["paraphrase"], expect: [{ path: "reversal.md" }] },
  ];
  const file = path.join(dir, "cases.json");
  const keyword = await runEvaluation(config, cases, file, { mode: "keyword" });
  const hybrid = await runEvaluation(config, cases, file, {
    mode: "hybrid",
    embedder: fake.embedder,
  });
  assert.equal(keyword.mode, "keyword");
  assert.equal(keyword.model, null);
  assert.equal(hybrid.model, "fake-model");
  assert.deepEqual(
    keyword.cases.map((c) => c.rank),
    [1, null],
  );
  assert.deepEqual(
    hybrid.cases.map((c) => c.rank),
    [1, 1],
  );
});

test("semantic configuration is validated and never downloads during normal use", async (t) => {
  const { dir, raw, configFile, roots } = await fixture(t);
  const write = (semantic: unknown) =>
    writeFile(configFile, JSON.stringify({ ...raw, semantic }));
  await write({ modelDir: path.join(roots.shared, "models") });
  await assert.rejects(loadConfig(configFile), /outside source roots/);
  await write({ keywordWeight: 0, semanticWeight: 0 });
  await assert.rejects(loadConfig(configFile), /cannot both be zero/);
  await write({ unknown: true });
  await assert.rejects(loadConfig(configFile), /Invalid configuration/);

  // With an empty model directory the configured model is unavailable offline.
  await write({ model: "Xenova/bge-small-en-v1.5", modelDir: path.join(dir, "empty-models") });
  const config: Config = await loadConfig(configFile);
  assert.equal(config.semantic?.keywordWeight, 1);
  assert.ok(config.semantic);
  await assert.rejects(
    getEmbedder(config.semantic),
    /fetch-model|@huggingface\/transformers/,
  );

  // Indexing still commits keyword results, reports the problem and exits 1.
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["src/cli.ts", ...args], {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: configFile },
    });
  const indexed = cli(["index"]);
  assert.equal(indexed.status, 1);
  assert.match(indexed.stderr, /Embeddings not updated/);
  assert.equal(JSON.parse(indexed.stdout).length, 3);
  // Default search degrades to keywords; explicit hybrid fails clearly.
  const fallback = cli(["search", "Singapore", "--project", "pilot"]);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(JSON.parse(fallback.stdout).results[0].relativePath, "hosting.md");
  assert.match(fallback.stderr, /using keywords/);
  const explicit = cli(["search", "Singapore", "--project", "pilot", "--mode", "hybrid"]);
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /fetch-model|@huggingface\/transformers/);
});
