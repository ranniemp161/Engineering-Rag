import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { Config } from "../config/load-config.ts";
import { buildCodeGraph, CODE_EXTENSIONS } from "./build-graph.ts";
import { codeGraphFor } from "./code-graph.ts";

type BuildSummary = Awaited<ReturnType<typeof buildCodeGraph>>;
export type CodeReason = "startup" | "change" | "reconcile" | "recovered";

export type CodeWatchEvent =
  | { event: "code-watching"; projectId: string; repository: string }
  | { event: "code-graph"; reason: CodeReason; result: BuildSummary }
  | { event: "error"; scopes: string[]; message: string }
  | { event: "watch-error"; scope: string; message: string; retryMs: number };

export interface CodeWatchOptions {
  report: (event: CodeWatchEvent) => void;
  /** Quiet period after the last code change before rebuilding (default 10 s). */
  debounceMs?: number;
  /** Upper bound on how long continuous edits can postpone a rebuild (default 60 s). */
  maxWaitMs?: number;
  retryMs?: number;
  /** Replaces the Graphify build, for example in tests. */
  build?: (projectId: string) => Promise<BuildSummary>;
}

/**
 * Rebuilds each configured project's code graph after its source files change.
 * Only source extensions Graphify parses count, excluded paths are ignored,
 * and builds run one at a time, so a burst of saves costs one rebuild. A
 * change during a build queues one more build after it. Graphify only reads
 * the repository; its output goes to the configured graph directory.
 */
export function startCodeGraphRefresh(config: Config, options: CodeWatchOptions) {
  const { report, debounceMs = 10_000, maxWaitMs = 60_000, retryMs = 5000 } = options;
  const build =
    options.build ?? ((projectId: string) => buildCodeGraph(config, projectId));
  const projects = config.scopes.filter((s) => s.type === "project" && s.codeGraph);
  const watchers = new Map<string, FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  const firstPending = new Map<string, number>();
  const reasons = new Map<string, CodeReason>();
  const attachTimers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  // One Graphify process at a time across all projects.
  let queue: Promise<void> = Promise.resolve();
  const building = new Set<string>();

  const relevant = (eventType: string, filename: string | null) => {
    if (filename === null) return true;
    const key = filename.split(path.sep).join("/");
    if (key === "graphify-out" || key.startsWith("graphify-out/")) return false;
    if (
      config.exclude.some(
        (pattern) => path.matchesGlob(key, pattern) || path.matchesGlob(`${key}/`, pattern),
      )
    )
      return false;
    const extension = path.extname(key).slice(1).toLowerCase();
    // A renamed or deleted folder has no extension but can remove source files.
    return CODE_EXTENSIONS.has(extension) || (extension === "" && eventType === "rename");
  };

  const schedule = (projectId: string, reason: CodeReason, delay = debounceMs) => {
    if (stopped) return;
    const now = Date.now();
    if (!firstPending.has(projectId)) firstPending.set(projectId, now);
    if (!reasons.has(projectId) || reason !== "change") reasons.set(projectId, reason);
    clearTimeout(timers.get(projectId));
    const first = firstPending.get(projectId) as number;
    const wait = Math.max(0, Math.min(delay, first + maxWaitMs - now));
    timers.set(projectId, setTimeout(() => enqueue(projectId), wait));
  };

  const enqueue = (projectId: string) => {
    timers.delete(projectId);
    // A build already queued or running will be followed by this one.
    if (building.has(projectId)) {
      schedule(projectId, reasons.get(projectId) ?? "change");
      return;
    }
    const reason = reasons.get(projectId) ?? "change";
    reasons.delete(projectId);
    firstPending.delete(projectId);
    building.add(projectId);
    queue = queue.then(async () => {
      try {
        if (!stopped) report({ event: "code-graph", reason, result: await build(projectId) });
      } catch (error) {
        // Not retried on a timer: the next change or reconcile tries again.
        report({
          event: "error",
          scopes: [projectId],
          message: `Code graph not updated: ${(error as Error).message}`,
        });
      } finally {
        building.delete(projectId);
      }
    });
  };

  const attach = (projectId: string, recovering: boolean) => {
    attachTimers.delete(projectId);
    if (stopped || watchers.has(projectId)) return;
    const { repository } = codeGraphFor(config, projectId);
    const retry = (error: Error) => {
      watchers.get(projectId)?.close();
      watchers.delete(projectId);
      report({
        event: "watch-error",
        scope: projectId,
        message: `code: ${(error as NodeJS.ErrnoException).code ?? error.message}`,
        retryMs,
      });
      if (!stopped && !attachTimers.has(projectId))
        attachTimers.set(projectId, setTimeout(() => attach(projectId, true), retryMs));
    };
    try {
      const watcher = watch(repository, { recursive: true }, (eventType, name) => {
        if (relevant(eventType, name)) schedule(projectId, "change");
      });
      watcher.on("error", retry);
      watchers.set(projectId, watcher);
      report({ event: "code-watching", projectId, repository });
      if (recovering) schedule(projectId, "recovered", 0);
    } catch (error) {
      retry(error as Error);
    }
  };

  for (const scope of projects) {
    attach(scope.id, false);
    // Startup catches edits made while nothing was watching; Graphify's cache keeps it cheap.
    schedule(scope.id, "startup", 0);
  }

  return {
    projects: projects.map((s) => s.id),
    reconcile() {
      for (const scope of projects) {
        // Renew the watcher so a replaced checkout is followed by path.
        watchers.get(scope.id)?.close();
        watchers.delete(scope.id);
        attach(scope.id, false);
        schedule(scope.id, "reconcile", 0);
      }
    },
    async stop() {
      stopped = true;
      for (const timer of [...timers.values(), ...attachTimers.values()]) clearTimeout(timer);
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      await queue;
    },
  };
}
