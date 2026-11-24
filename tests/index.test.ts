import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseMarkdown } from "../src/markdown/chunk-markdown.ts";
import { readNote } from "../src/filesystem/markdown-reader.ts";
import { withReadSession, } from "../src/storage/index-session.ts";

test("chunk bounds, heading ancestry, fences and line citations", () => {
  const lines = [
    "# Top",
    "## Child",
    "~~~js",
    "# inside",
    "~~~",
    "x".repeat(4200),
  ];
  const parsed = parseMarkdown(lines.join("\r\n"), "fallback");
  assert.equal(parsed.title, "Top");
  assert.deepEqual(
    parsed.chunks.find((c) => c.content.includes("# inside")),
    {
      content: lines.slice(2, 5).join("\n"),
      startLine: 3,
      endLine: 5,
      headingPath: "Top / Child",
    },
  );
  for (const c of parsed.chunks) {
    assert.ok(c.content.length <= 1600);
    assert.ok(
      lines
        .slice(c.startLine - 1, c.endLine)
        .join("\n")
        .includes(c.content),
    );
  }
  assert.deepEqual(parseMarkdown("", "empty").chunks, []);
});

test("CLI maintains the local index, isolates failed scans and rolls back incomplete rebuilds", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-index-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "index.db"),
    config = path.join(dir, "config.json"),
    shared = path.join(dir, "shared"),
    project = path.join(dir, "project");
  for (const root of [
    shared,
    project,
    path.join(dir, "outside"),
    path.join(shared, ".obsidian"),
  ])
    await mkdir(root);
  const scopes = [
    { id: "shared", displayName: "Shared", type: "shared", rootPath: shared },
    {
      id: "project",
      displayName: "Project",
      type: "project",
      rootPath: project,
    },
  ];
  await writeFile(config, JSON.stringify({ databasePath: file, scopes }));
  const note = path.join(shared, "guide.md");
  await writeFile(
    note,
    "---\ntitle: Review\ntags: [ops, docs]\n---\n# Guide\nlegacyterm\n",
  );
  await writeFile(path.join(project, "project.md"), "otherterm");
  await writeFile(path.join(dir, "outside", "private.md"), "excluded");
  await assert.rejects(readNote(shared, "../outside/private.md"), /escapes/);
  await writeFile(path.join(shared, ".obsidian", "private.md"), "excluded");
  await symlink(
    path.join(dir, "outside"),
    path.join(shared, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const fingerprint = async () => [
    createHash("sha256")
      .update(await readFile(note))
      .digest("hex"),
    (await stat(note, { bigint: true })).mtimeNs,
  ];
  const cli = (command: string, exit = 0) => {
    const run = spawnSync(process.execPath, ["src/cli.ts", command], {
      encoding: "utf8",
      timeout: 15000,
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: config },
    });
    assert.equal(run.status, exit, run.stderr + run.stdout);
    return run.stdout ? JSON.parse(run.stdout) : run.stderr;
  };
  const match = (term: string) =>
    withReadSession({ databasePath: file, scopes: [] }, [], ({ db }) =>
      db.all(
        "SELECT document_id,content,start_line,end_line FROM chunks WHERE fts_match(content,?1) ORDER BY fts_score(content,?1) DESC",
        term,
      ),
    );
  assert.equal(cli("status").initialized, false);
  const before = await fingerprint();
  assert.deepEqual(
    cli("index").map((s: { updated: number }) => s.updated),
    [1, 1],
  );
  assert.deepEqual(await fingerprint(), before);
  assert.deepEqual(await match("excluded"), []);
  const [old] = await match("legacyterm");
  assert.equal(old.start_line, 5);
  const meta = await withReadSession({ databasePath: file, scopes: [] }, [], ({ db }) =>
    db.get("SELECT title,tags FROM documents WHERE id=?", old.document_id),
  );
  assert.equal(meta.title, "Review");
  assert.deepEqual(JSON.parse(meta.tags), ["ops", "docs"]);
  assert.deepEqual(
    cli("index").map((s: { unchanged: number }) => s.unchanged),
    [1, 1],
  );
  await writeFile(note, "# Guide\nchangedterm");
  assert.equal(cli("index")[0].updated, 1);
  assert.deepEqual(await match("legacyterm"), []);
  assert.equal((await match("changedterm"))[0].document_id, old.document_id);
  await rename(project, path.join(dir, "unavailable"));
  await writeFile(note, "# Guide\nhealthyterm");
  const partial = cli("index", 1);
  assert.equal(partial[0].updated, 1);
  assert.equal(partial[1].status, "partial");
  assert.equal((await match("otherterm")).length, 1);
  assert.equal(
    cli("status").scopes.find((s: { id: string }) => s.id === "project")
      .errors[0].code,
    "DIRECTORY_UNAVAILABLE",
  );
  await writeFile(note, "# Guide\nrebuiltterm");
  assert.match(cli("rebuild", 1), /rolled back/);
  assert.equal((await match("healthyterm")).length, 1);
  assert.deepEqual(await match("rebuiltterm"), []);
  await rename(path.join(dir, "unavailable"), project);
  const preRebuild = await fingerprint();
  cli("rebuild");
  assert.equal((await match("rebuiltterm"))[0].document_id, old.document_id);
  assert.deepEqual(await fingerprint(), preRebuild);
  await rm(note);
  assert.equal(cli("index")[0].removed, 1);
  assert.deepEqual(await match("rebuiltterm"), []);
  const report = cli("status").scopes.find(
    (s: { id: string }) => s.id === "shared",
  );
  assert.equal(report.documents, 0);
  assert.equal(report.chunks, 0);
  assert.ok(report.lastSuccess);
  await withReadSession({ databasePath: file, scopes: [] }, [], async () => {
    assert.match(cli("index", 1), /INDEX_BUSY/);
  });
});
