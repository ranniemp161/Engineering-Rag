import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  IndexBusyError,
  IndexMissingError,
  IndexRootChangedError,
  UnknownScopeError,
  withReadSession,
  withWriteSession,
} from "../src/storage/index-session.ts";

const capabilities = (config: Parameters<typeof withReadSession>[0]) =>
  withReadSession(config, [], async (session) => session.capabilities);

async function fixture(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-session-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  return {
    dir,
    config: {
      databasePath: path.join(dir, "data", "index.db"),
      scopes: [
        { id: "shared", displayName: "Shared", type: "shared" as const, rootPath: shared },
      ],
    },
  };
}

test("a read session on a missing index reports it and creates no files", async (t) => {
  const { dir, config } = await fixture(t);
  await assert.rejects(
    withReadSession(config, [], async () => "unreachable"),
    (error) =>
      error instanceof IndexMissingError &&
      /Index missing\. Run the index command first\./.test(error.message),
  );
  assert.deepEqual(await readdir(dir), []);
});

test("a read session can return a fallback for a missing index instead of failing", async (t) => {
  const { dir, config } = await fixture(t);
  const status = await withReadSession(config, [], async () => "opened", {
    whenMissing: () => "missing",
  });
  assert.equal(status, "missing");
  assert.deepEqual(await readdir(dir), []);
  await withWriteSession(config, [], async () => {});
  assert.equal(
    await withReadSession(config, [], async () => "opened", { whenMissing: () => "missing" }),
    "opened",
  );
});

test("a write session creates the schema with every capability", async (t) => {
  const { config } = await fixture(t);
  const written = await withWriteSession(config, ["shared"], async (s) => s.capabilities);
  assert.deepEqual(written, { embeddings: true, references: true });
  assert.deepEqual(await capabilities(config), { embeddings: true, references: true });
});

test("older schemas read without upgrading and upgrade on the next write", async (t) => {
  const { config } = await fixture(t);
  const downgrade = (version: number) =>
    withWriteSession(config, [], async ({ db }) => {
      await db.exec("DROP TABLE IF EXISTS document_references");
      if (version === 1) await db.exec("DROP TABLE chunk_embeddings");
      await db.exec(`UPDATE engineering_index_version SET version = ${version}`);
    });
  await withWriteSession(config, [], async () => {});
  await downgrade(2);
  assert.deepEqual(await capabilities(config), { embeddings: true, references: false });
  await downgrade(1);
  assert.deepEqual(await capabilities(config), { embeddings: false, references: false });
  await withWriteSession(config, [], async () => {});
  assert.deepEqual(await capabilities(config), { embeddings: true, references: true });
});

test("a second session waits, then reports the index busy", async (t) => {
  const { config } = await fixture(t);
  await withWriteSession(config, [], async () => {});
  await withReadSession(config, [], async () => {
    const started = performance.now();
    await assert.rejects(
      withReadSession(config, [], async () => {}),
      (error) => error instanceof IndexBusyError && /^INDEX_BUSY/.test(error.message),
    );
    // The wait is bounded: about one second, never indefinite.
    const waited = performance.now() - started;
    assert.ok(waited >= 900 && waited < 5000, `waited ${waited} ms`);
  });
});

test("a moved scope root is refused unless rebuilding", async (t) => {
  const { dir, config } = await fixture(t);
  await withWriteSession(config, ["shared"], async ({ db }) => {
    await db.run(
      "INSERT INTO scopes VALUES('shared','Shared',?,'shared','2026-01-01')",
      path.join(dir, "shared"),
    );
  });
  const moved = {
    ...config,
    scopes: [{ id: "shared", rootPath: path.join(dir, "elsewhere") }],
  };
  await assert.rejects(
    withReadSession(moved, ["shared"], async () => {}),
    (error) => error instanceof IndexRootChangedError && /Rebuild the index/.test(error.message),
  );
  await assert.rejects(
    withWriteSession(moved, ["shared"], async () => {}),
    (error) => error instanceof IndexRootChangedError && /Scope shared changed roots/.test(error.message),
  );
  // Sessions that touch no moved scope, and rebuilds, still open.
  await withReadSession(moved, [], async () => {});
  await withWriteSession(moved, ["shared"], async () => {}, { rebuild: true });
});

test("an unknown project is refused before the index is opened", async (t) => {
  const { dir, config } = await fixture(t);
  const unknown = (error: unknown) =>
    error instanceof UnknownScopeError && /^Unknown project ID$/.test(error.message);
  await assert.rejects(withReadSession(config, ["shared", "nope"], async () => {}), unknown);
  await assert.rejects(withWriteSession(config, ["nope"], async () => {}), unknown);
  assert.deepEqual(await readdir(dir), []);
});

test("the guard file survives a rebuild and linked sidecars are refused", async (t) => {
  const { dir, config } = await fixture(t);
  await withWriteSession(config, [], async () => {});
  const guard = `${config.databasePath}.guard`;
  const before = await stat(guard);
  await withWriteSession(config, ["shared"], async () => {}, { rebuild: true });
  assert.equal((await stat(guard)).ino, before.ino);
  await link(guard, path.join(dir, "extra-link"));
  await assert.rejects(
    withReadSession(config, [], async () => {}),
    /ordinary private files/,
  );
});

test("a symlinked sidecar is refused", async (t) => {
  const { dir, config } = await fixture(t);
  await withWriteSession(config, [], async () => {});
  const target = path.join(dir, "elsewhere");
  await mkdir(target);
  // A junction needs no privilege on Windows; elsewhere a directory symlink.
  await symlink(target, `${config.databasePath}-journal`, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    withReadSession(config, [], async () => {}),
    /ordinary private files/,
  );
});
