import { spawn } from "node:child_process";
import type { TestContext } from "node:test";

/**
 * Starts the viewer on an OS-chosen port and resolves once its ready line
 * names the bound address. Rejects if the viewer exits or stays silent.
 */
export async function startViewer(t: TestContext, config: string, args: string[] = []) {
  const child = spawn(
    process.execPath,
    ["src/viewer/server.ts", "--no-open", "--port", "0", ...args],
    {
      env: { ...process.env, ENGINEERING_INTELLIGENCE_CONFIG: config },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  // Wait for the viewer to exit so it never outlives its test.
  const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  t.after(async () => {
    child.kill();
    await exit;
  });
  let stderr = "";
  const listeners = new Set<() => void>();
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    for (const listener of listeners) listener();
  });
  /** Resolves with the first match of `pattern` in stderr, waiting for output. */
  const waitFor = (pattern: RegExp, timeoutMs = 10000) =>
    new Promise<RegExpMatchArray>((resolve, reject) => {
      const done = (settle: () => void) => {
        clearTimeout(timer);
        listeners.delete(check);
        child.off("exit", exited);
        settle();
      };
      const check = () => {
        const match = stderr.match(pattern);
        if (match) done(() => resolve(match));
      };
      const exited = (code: number | null) =>
        done(() => reject(new Error(`Viewer exited (${code}): ${stderr}`)));
      const timer = setTimeout(
        () => done(() => reject(new Error(`Timed out waiting for ${pattern}: ${stderr}`))),
        timeoutMs,
      );
      listeners.add(check);
      child.once("exit", exited);
      check();
      // The viewer may already have exited before this wait began.
      if (child.exitCode !== null || child.signalCode !== null) exited(child.exitCode);
    });
  const [, url] = await waitFor(/Engineering index viewer: (http:\/\/127\.0\.0\.1:\d+)/);
  return { url, waitFor, stderr: () => stderr };
}
