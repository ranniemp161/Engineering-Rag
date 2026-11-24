import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../src/config/load-config.ts";
import { extractReferences } from "../src/markdown/references.ts";
import { detectProject } from "../src/mcp/project-detection.ts";
import { getRelatedDocuments } from "../src/retrieval/related.ts";
import { withIndex } from "../src/storage/turso.ts";

test("reference extraction covers links, wikilinks and numbers but not code or dates", () => {
  const source = [
    "# 0020. Title", // 1: self-number, resolved away later
    "Amended by 0021. See decision `0002` and (0004).", // 2
    "[Plan](../PLAN.md#gate) and [site](https://x.test/a.md) and [here](#top)", // 3
    "[wrapped", // 4
    "text](notes/Other%20Note.md)", // 5
    "[[Glossary]] [[folder/Deep|alias]] [[Heading note#Part]] ![[diagram.png]]", // 6
    "Date: 2026-11-14, version 1.0020, path a/0030, id D-0031, 12 items", // 7
    "```", // 8
    "0099 [x](code.md) [[Code]]", // 9: fenced
    "```", // 10
  ].join("\r\n");
  assert.deepEqual(
    extractReferences(source).map((r) => `${r.line}:${r.kind}:${r.target}`),
    [
      "1:number:0020",
      "2:number:0002",
      "2:number:0004",
      "2:number:0021",
      "3:link:../PLAN.md",
      "5:link:notes/Other Note.md",
      "6:wikilink:folder/Deep",
      "6:wikilink:Glossary",
      "6:wikilink:Heading note",
    ],
  );
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const roots = Object.fromEntries(
    ["shared", "pilot", "other", "repo"].map((id) => [id, path.join(dir, id)]),
  ) as Record<"shared" | "pilot" | "other" | "repo", string>;
  for (const root of Object.values(roots)) await mkdir(root, { recursive: true });
  await mkdir(path.join(roots.pilot, "decisions"));
  await mkdir(path.join(roots.other, "decisions"));
  await mkdir(path.join(roots.repo, "src"));
  const files: Record<string, string> = {
    "shared/Glossary.md": "# Glossary\nUtang means credit.\n",
    "pilot/decisions/0001-first.md":
      "# 0001. First\nStatus: amended by 0002\nTerms in [[Glossary]].\n",
    "pilot/decisions/0002-second.md":
      "# 0002. Second\nAmends decision `0001`.\nSee [the plan](../PLAN.md#gate).\n",
    "pilot/PLAN.md": "# Plan\nTask 1 follows 0002.\nUnknown 0099 and [[Missing]].\n",
    "other/decisions/0001-elsewhere.md": "# 0001. Elsewhere\nAlso cites 0002.\n",
  };
  for (const [file, text] of Object.entries(files))
    await writeFile(path.join(dir, file), text);
  const configFile = path.join(dir, "config.json");
  const raw = {
    databasePath: path.join(dir, "index.db"),
    detectProject: true,
    scopes: [
      { id: "shared", displayName: "Shared", type: "shared", rootPath: roots.shared },
      { id: "pilot", displayName: "Pilot", type: "project", rootPath: roots.pilot, repositories: [roots.repo] },
      { id: "other", displayName: "Other", type: "project", rootPath: roots.other },
    ],
  };
  await writeFile(configFile, JSON.stringify(raw));
  const env = { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: configFile };
  const index = () => {
    const run = spawnSync(process.execPath, ["src/cli.ts", "index"], { env, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  };
  index();
  const config = await loadConfig(configFile);
  const idOf = (scope: string, relativePath: string) =>
    withIndex(config.databasePath, true, (db) =>
      db.get("SELECT id FROM documents WHERE scope_id=? AND relative_path=?", scope, relativePath),
    ).then((row) => row?.id as string);
  const related = async (scope: string, relativePath: string, projectId?: string) => {
    const r = await getRelatedDocuments(config, {
      documentId: await idOf(scope, relativePath),
      projectId,
    });
    const keys = (list: typeof r.outgoing) =>
      list.map((x) => `${x.scope}:${x.relativePath}@${x.references.map((c) => c.line).join(",")}`);
    return { out: keys(r.outgoing), in: keys(r.incoming), raw: r };
  };
  return { dir, roots, config, configFile, raw, env, index, idOf, related };
}

test("related documents resolve within visible scopes in both directions", async (t) => {
  const { dir, config, index, related, idOf } = await fixture(t);
  const first = await related("pilot", "decisions/0001-first.md", "pilot");
  // Self-number on line 1 is dropped; the wikilink reaches the shared glossary.
  assert.deepEqual(first.out, ["pilot:decisions/0002-second.md@2", "shared:Glossary.md@3"]);
  // Another project's 0001 cites 0002, but numbers resolve only in their own scope.
  assert.deepEqual(first.in, ["pilot:decisions/0002-second.md@2"]);
  assert.equal(first.raw.outgoing[0]?.references[0]?.context, "Status: amended by 0002");
  assert.equal(first.raw.outgoing[0]?.references[0]?.kind, "number");

  const second = await related("pilot", "decisions/0002-second.md", "pilot");
  assert.deepEqual(second.out, ["pilot:decisions/0001-first.md@2", "pilot:PLAN.md@3"]);
  assert.deepEqual(second.in, ["pilot:decisions/0001-first.md@2", "pilot:PLAN.md@2"]);
  // Unresolvable and ambiguous references are omitted, not guessed.
  assert.deepEqual((await related("pilot", "PLAN.md", "pilot")).out, [
    "pilot:decisions/0002-second.md@2",
  ]);

  // Shared notes list only shared links; project documents need their project.
  const glossary = await related("shared", "Glossary.md");
  assert.deepEqual(glossary.in, []);
  assert.deepEqual((await related("shared", "Glossary.md", "pilot")).in, [
    "pilot:decisions/0001-first.md@3",
  ]);
  await assert.rejects(
    getRelatedDocuments(config, { documentId: await idOf("pilot", "PLAN.md") }),
    /Document unavailable in the requested scope/,
  );
  await assert.rejects(
    getRelatedDocuments(config, {
      documentId: await idOf("pilot", "PLAN.md"),
      projectId: "other",
    }),
    /Document unavailable in the requested scope/,
  );

  // Editing a note replaces its references; a note added later resolves without
  // rescanning the notes that already pointed at it.
  await writeFile(path.join(dir, "pilot", "PLAN.md"), "# Plan\nNo references now. [[Later]]\n");
  index();
  assert.deepEqual((await related("pilot", "decisions/0002-second.md", "pilot")).in, [
    "pilot:decisions/0001-first.md@2",
  ]);
  await writeFile(path.join(dir, "pilot", "Later.md"), "# Later\n");
  index();
  assert.deepEqual((await related("pilot", "Later.md", "pilot")).in, ["pilot:PLAN.md@2"]);
  const cli = spawnSync(
    process.execPath,
    ["src/cli.ts", "related", await idOf("pilot", "Later.md"), "--project", "pilot"],
    { env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: path.join(dir, "config.json") }, encoding: "utf8" },
  );
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).incomingTotal, 1);
});

test("an older index gains references on its next write without rescanning notes", async (t) => {
  const { config, index, related } = await fixture(t);
  await withIndex(config.databasePath, false, async (db) => {
    await db.exec("DROP TABLE document_references");
    await db.exec("UPDATE engineering_index_version SET version = 2");
  });
  await assert.rejects(
    related("pilot", "decisions/0001-first.md", "pilot"),
    /Run the index command/,
  );
  index();
  assert.deepEqual((await related("pilot", "decisions/0001-first.md", "pilot")).out, [
    "pilot:decisions/0002-second.md@2",
    "shared:Glossary.md@3",
  ]);
});

test("project detection maps a workspace to exactly one project", async (t) => {
  const { dir, roots, config, configFile, raw } = await fixture(t);
  assert.equal(await detectProject(config, [path.join(roots.repo, "src")]), "pilot");
  assert.equal(await detectProject(config, [roots.pilot]), "pilot");
  assert.equal(await detectProject(config, [roots.other]), "other");
  assert.equal(await detectProject(config, [dir]), undefined);
  // Two different projects in one workspace select none.
  assert.equal(await detectProject(config, [roots.repo, roots.other]), undefined);
  await writeFile(
    configFile,
    JSON.stringify({
      ...raw,
      scopes: raw.scopes.map((s) =>
        s.id === "shared" ? { ...s, repositories: [roots.repo] } : s,
      ),
    }),
  );
  await assert.rejects(loadConfig(configFile), /Only project scopes may list repositories/);
});

async function mcpClient(
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; roots?: string[] },
) {
  const client = new Client(
    { name: "links-test", version: "1" },
    options.roots ? { capabilities: { roots: {} } } : {},
  );
  if (options.roots)
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: (options.roots ?? []).map((root) => ({ uri: pathToFileURL(root).href })),
    }));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(process.env.TEST_COMPILED_MCP === "1" ? "dist/mcp/server.js" : "src/mcp/server.ts")],
    env: { ENGINEERING_INTELLIGENCE_CONFIG: env.ENGINEERING_INTELLIGENCE_CONFIG as string },
    cwd: options.cwd,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "";
    return result.isError ? { error: text } : JSON.parse(text);
  };
  return { client, call, stderr: () => stderr };
}

test("MCP tools use the detected project only when projectId is omitted", async (t) => {
  const { roots, env, idOf } = await fixture(t);
  // Servers must exit before the fixture folder is removed, so close them here
  // rather than in later after-hooks, which run after the fixture's cleanup.
  const clients: Client[] = [];
  try {
    await detectionChecks(roots, env, idOf, clients);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

async function detectionChecks(
  roots: Record<"shared" | "pilot" | "other" | "repo", string>,
  env: NodeJS.ProcessEnv,
  idOf: (scope: string, relativePath: string) => Promise<string>,
  clients: Client[],
) {
  const viaRoots = await mcpClient(env, { roots: [path.join(roots.repo, "src")] });
  clients.push(viaRoots.client);
  const { tools } = await viaRoots.client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "get_code_impact",
    "get_document",
    "get_related_documents",
    "search_code_graph",
    "search_engineering_knowledge",
  ]);
  const found = await viaRoots.call("search_engineering_knowledge", { query: "Plan" });
  assert.equal(found.detectedProjectId, "pilot");
  assert.ok(found.results.some((r: { scope: string }) => r.scope === "pilot"));
  const planId = await idOf("pilot", "PLAN.md");
  assert.equal(
    (await viaRoots.call("get_document", { documentId: planId })).relativePath,
    "PLAN.md",
  );
  const links = await viaRoots.call("get_related_documents", { documentId: planId });
  assert.equal(links.detectedProjectId, "pilot");
  assert.equal(links.outgoingTotal, 1);
  // An explicit projectId wins over detection.
  const explicit = await viaRoots.call("search_engineering_knowledge", {
    query: "Elsewhere",
    projectId: "other",
  });
  assert.equal(explicit.detectedProjectId, undefined);
  assert.ok(explicit.results.every((r: { scope: string }) => r.scope !== "pilot"));

  // Without roots, the launch directory decides; outside any project, shared only.
  const viaCwd = await mcpClient(env, { cwd: roots.other });
  clients.push(viaCwd.client);
  assert.equal(
    (await viaCwd.call("search_engineering_knowledge", { query: "Elsewhere" })).detectedProjectId,
    "other",
  );
  const outside = await mcpClient(env, { cwd: path.dirname(roots.shared) });
  clients.push(outside.client);
  const shared = await outside.call("search_engineering_knowledge", { query: "Plan" });
  assert.equal(shared.detectedProjectId, undefined);
  assert.ok(shared.results.every((r: { scope: string }) => r.scope === "shared"));
  assert.equal(viaRoots.stderr() + viaCwd.stderr() + outside.stderr(), "");
}
