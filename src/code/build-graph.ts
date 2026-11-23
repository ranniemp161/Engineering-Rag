import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/load-config.ts";
import { codeGraphFor } from "./code-graph.ts";

// Removed from Graphify's environment so a code build can never reach an LLM.
const LLM_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MOONSHOT_API_KEY",
  "KIMI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_HOST",
];

/**
 * Builds or refreshes a project's code graph with `graphify update`, which
 * extracts code structurally (tree-sitter) without an LLM. GRAPHIFY_OUT sends
 * every output file to the configured directory, so the repository itself is
 * only read. Clustering is skipped; the engine does not use communities.
 */
export async function buildCodeGraph(
  config: Config,
  projectId: string,
  // Tests substitute a fake Graphify; operators can point GRAPHIFY_COMMAND at an executable.
  runner: { command: string; prefixArgs?: string[] } = {
    command: process.env.GRAPHIFY_COMMAND ?? "graphify",
  },
) {
  const { repository, output } = codeGraphFor(config, projectId);
  await mkdir(output, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHIFY_OUT: output };
  for (const key of LLM_KEYS) delete env[key];
  const started = performance.now();
  const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const args = [...(runner.prefixArgs ?? []), "update", repository, "--no-cluster"];
      const child = spawn(runner.command, args, {
        cwd: output,
        env,
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (error: NodeJS.ErrnoException) =>
        reject(
          error.code === "ENOENT"
            ? new Error("Graphify was not found. Install it or set GRAPHIFY_COMMAND.")
            : error,
        ),
      );
      child.on("close", (code) => resolve({ code, stderr }));
    },
  );
  if (code !== 0)
    throw new Error(`graphify update failed (exit ${code}): ${stderr.trim().slice(-500)}`);
  const graph = JSON.parse(await readFile(path.join(output, "graph.json"), "utf8"));
  return {
    projectId,
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    links: Array.isArray(graph.links) ? graph.links.length : 0,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
}
