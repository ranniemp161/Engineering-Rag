import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (!address || typeof address === "string") throw new Error("No port");
  return address.port;
}

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
  const port = await freePort();
  const child = spawn(
    process.execPath,
    ["src/viewer/server.ts", "--no-open", "--port", String(port)],
    {
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: config },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  t.after(() => {
    child.kill();
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  for (let i = 0; i < 100 && !stderr.includes("viewer"); i++) await delay(50);
  const overview = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/overview`);
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
  for (let i = 0; i < 40 && !stderr.includes("Viewer request failed"); i++) await delay(50);
  assert.match(stderr, /Viewer request failed/);
});
