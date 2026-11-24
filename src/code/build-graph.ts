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

export interface GraphifyRunner {
  command: string;
  prefixArgs?: string[];
}

// Tests substitute a fake Graphify; operators can point GRAPHIFY_COMMAND at an executable.
const defaultRunner = (): GraphifyRunner => ({
  command: process.env.GRAPHIFY_COMMAND ?? "graphify",
});

function runGraphify(runner: GraphifyRunner, args: string[], output: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHIFY_OUT: output };
  for (const key of LLM_KEYS) delete env[key];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(runner.command, [...(runner.prefixArgs ?? []), ...args], {
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
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`graphify ${args[0]} failed (exit ${code}): ${stderr.trim().slice(-500)}`),
          ),
    );
  });
}

/**
 * Builds or refreshes a project's code graph with `graphify update`, which
 * extracts code structurally (tree-sitter) without an LLM. GRAPHIFY_OUT sends
 * every output file to the configured directory, so the repository itself is
 * only read; LLM API keys are removed from Graphify's environment.
 *
 * With `visualize`, it then clusters the graph without LLM labels
 * (`cluster-only --no-label`, which writes graph.html and GRAPH_REPORT.md and
 * adds community IDs to graph.json) and writes GRAPH_TREE.html with `tree`.
 */
export async function buildCodeGraph(
  config: Config,
  projectId: string,
  options: { visualize?: boolean; runner?: GraphifyRunner } = {},
) {
  const { repository, output } = codeGraphFor(config, projectId);
  const runner = options.runner ?? defaultRunner();
  const visualize =
    options.visualize ??
    config.scopes.find((s) => s.id === projectId)?.codeGraph?.visualize ??
    false;
  await mkdir(output, { recursive: true });
  const started = performance.now();
  const graphFile = path.join(output, "graph.json");
  await runGraphify(runner, ["update", repository, "--no-cluster"], output);
  if (visualize) {
    await runGraphify(runner, ["cluster-only", repository, "--graph", graphFile, "--no-label"], output);
    const label = config.scopes.find((s) => s.id === projectId)?.displayName ?? projectId;
    await runGraphify(
      runner,
      ["tree", "--graph", graphFile, "--output", path.join(output, "GRAPH_TREE.html"), "--label", label],
      output,
    );
  }
  const graph = JSON.parse(await readFile(graphFile, "utf8"));
  return {
    projectId,
    nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
    links: Array.isArray(graph.links) ? graph.links.length : 0,
    visualized: visualize,
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
}

// Source extensions Graphify parses; changes to other files never trigger a rebuild.
export const CODE_EXTENSIONS = new Set(
  (
    "ts tsx mts cts js jsx mjs cjs py pyi go rs java kt kts scala swift rb php cs " +
    "c h cc cpp cxx hpp hh m mm dart vue svelte astro lua ex exs erl hs ml clj " +
    "sql sh ps1 r jl zig sol"
  ).split(" "),
);
