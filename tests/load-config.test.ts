import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { loadConfig } from "../src/config/load-config.ts";

async function fixture(t: TestContext) {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "engineering-config-")),
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.local.json");
  const scopes = ["shared", "example"].map((id) => ({
    id,
    type: id === "shared" ? "shared" : "project",
    displayName: id,
    rootPath: id,
  }));
  const sample = "# Offline inventory\nUse the approved local repository.\n";
  for (const scope of scopes) {
    const root = path.join(dir, scope.rootPath);
    await mkdir(root);
    await writeFile(path.join(root, "note.md"), sample);
  }
  const config = { databasePath: "data/index.db", scopes };
  const save = (overrides: Record<string, unknown> = {}) =>
    writeFile(file, JSON.stringify({ ...config, ...overrides }));
  await save();
  return { dir, file, scopes, save, sample };
}

test("loads config-relative paths and defaults without writing into the fixture", async (t) => {
  const f = await fixture(t);
  const config = await loadConfig(f.file);
  assert.deepEqual(config.search, { defaultLimit: 5, maxLimit: 20 });
  assert.ok(config.exclude.includes("**/.obsidian/**"));
  assert.deepEqual(
    config.scopes.map((s) => s.rootPath),
    ["shared", "example"].map((id) => path.join(f.dir, id)),
  );
  assert.equal(config.databasePath, path.join(f.dir, "data", "index.db"));
  await assert.rejects(access(path.dirname(config.databasePath)), {
    code: "ENOENT",
  });
  assert.equal(
    await readFile(path.join(f.dir, "shared", "note.md"), "utf8"),
    f.sample,
  );
});

test("uses the environment override and accepts a shared-only configuration", async (t) => {
  const f = await fixture(t);
  await f.save({
    scopes: f.scopes.slice(0, 1),
    exclude: ["**/private/**"],
    search: { defaultLimit: 2, maxLimit: 4 },
  });
  const old = process.env.ENGINEERING_INTELLIGENCE_CONFIG;
  t.after(() => {
    if (old === undefined) delete process.env.ENGINEERING_INTELLIGENCE_CONFIG;
    else process.env.ENGINEERING_INTELLIGENCE_CONFIG = old;
  });
  process.env.ENGINEERING_INTELLIGENCE_CONFIG = f.file;
  const config = await loadConfig();
  assert.deepEqual(config.search, { defaultLimit: 2, maxLimit: 4 });
  assert.deepEqual(config.exclude, ["**/private/**"]);
  assert.equal(config.scopes.length, 1);
});

test("reports missing and malformed configuration", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    loadConfig(path.join(f.dir, "absent.json")),
    /absent\.json/,
  );
  await writeFile(f.file, "{");
  await assert.rejects(loadConfig(f.file), /Cannot read JSON configuration/);
});

test("rejects ambiguous scopes, invalid limits and unsafe locations", async (t) => {
  const f = await fixture(t);
  const [shared, project] = f.scopes;
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ scopes: [] }, /scopes/],
    [{ scopes: [project] }, /shared/],
    [{ scopes: [shared, shared] }, /Duplicate/],
    [{ scopes: [shared, { ...project, rootPath: "shared" }] }, /Overlapping/],
    [{ scopes: [{ ...shared, rootPath: "absent" }] }, /rootPath/],
    [{ scopes: [{ ...shared, rootPath: "shared/note.md" }] }, /directory/],
    [{ scopes: [{ ...shared, rootPath: "//host/share" }] }, /local filesystem/],
    [{ databasePath: "libsql://example.invalid/db" }, /local filesystem/],
    [{ databasePath: "\\\\host\\share\\db" }, /local filesystem/],
    [{ databasePath: ":memory:" }, /local filesystem/],
    [{ databasePath: "shared/new.db" }, /outside source roots/],
    [{ databasePath: "config.local.json" }, /separate from the configuration/],
    [{ search: { defaultLimit: 0 } }, /defaultLimit/],
    [{ search: { maxLimit: 21 } }, /maxLimit/],
    [{ search: { defaultLimit: 6, maxLimit: 5 } }, /exceeds/],
    [{ syncUrl: "https://example.invalid" }, /Invalid configuration/],
  ];
  for (const [overrides, expected] of cases) {
    await f.save(overrides);
    await assert.rejects(
      loadConfig(f.file),
      expected,
      JSON.stringify(overrides),
    );
  }
});

test("resolves a directory alias before accepting a future database path", async (t) => {
  const f = await fixture(t);
  await symlink(
    path.join(f.dir, "shared"),
    path.join(f.dir, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await f.save({ databasePath: "alias/missing/index.db" });
  await assert.rejects(loadConfig(f.file), /outside source roots/);
});
