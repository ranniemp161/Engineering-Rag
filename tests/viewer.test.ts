import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startViewer } from "./start-viewer.ts";

test("viewer overview reports a missing index without creating files, and hides other errors", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "engineering-viewer-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = path.join(dir, "shared");
  await mkdir(shared);
  const config = path.join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      databasePath: "./data/index.db",
      scopes: [{ id: "shared", displayName: "Shared", type: "shared", rootPath: "./shared" }],
    }),
  );
  const viewer = await startViewer(t, config);
  const overview = async () => {
    const response = await fetch(`${viewer.url}/api/overview`);
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual(await overview(), {
    status: 400,
    body: { error: "Index missing. Run the index command first." },
  });
  assert.deepEqual((await readdir(dir)).sort(), ["config.json", "shared"]);

  // A file that is not an index fails with a generic message; details go to stderr.
  await mkdir(path.join(dir, "data"));
  await writeFile(path.join(dir, "data", "index.db"), "not a database");
  const broken = await overview();
  assert.equal(broken.status, 400);
  assert.equal(broken.body.error, "Request failed. Check the viewer diagnostics.");
  assert.ok(!JSON.stringify(broken.body).includes(dir));
  await viewer.waitFor(/Viewer request failed/);
});
