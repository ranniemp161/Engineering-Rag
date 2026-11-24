import { type FSWatcher, watch } from "node:fs";
import path from "node:path";
import type { Config } from "../config/load-config.ts";
import { IndexBusyError, withWriteSession } from "../storage/index-session.ts";
import { embedPending } from "../semantic/embed-index.ts";
import { type Embedder, getEmbedder } from "../semantic/embedder.ts";
import {
  type CodeWatchEvent,
  type CodeWatchOptions,
  startCodeGraphRefresh,
} from "../code/code-watch.ts";
import { indexNotes } from "./index-service.ts";

type ScanSummary = Awaited<ReturnType<typeof indexNotes>>[number];

export type WatchEvent =
  | { event: "watching"; scope: string; root: string }
  | { event: "watch-error"; scope: string; message: string; retryMs: number }
  | {
      event: "scan";
      reason: "startup" | "change" | "reconcile" | "recovered";
      results: ScanSummary[];
    }
  | { event: "embedded"; model: string; embedded: number; vectors: number; chunks: number }
  | { event: "busy"; scopes: string[]; retryMs: number }
  | { event: "error"; scopes: string[]; message: string }
  | CodeWatchEvent
  | { event: "stopped" };

export interface WatchOptions {
  signal: AbortSignal;
  report: (event: WatchEvent) => void;
  /** Quiet period after the last relevant change before a scope is rescanned. */
  debounceMs?: number;
  /** Upper bound on how long continuous changes can postpone a rescan. */
  maxWaitMs?: number;
  /** Full rescan interval that recovers missed events; 0 disables it. */
  reconcileMs?: number;
  /** Delay before retrying a busy index or reattaching to an unavailable root. */
  retryMs?: number;
  /** Overrides the configured embedding model, for example in tests. */
  embedder?: Embedder;
  /** Rebuild code graphs after source changes (default true when any project has one). */
  code?: boolean;
  /** Quiet period after the last code change before a code graph rebuild. */
  codeDebounceMs?: number;
  /** Replaces the Graphify build, for example in tests. */
  codeBuild?: CodeWatchOptions["build"];
}

type Reason = Extract<WatchEvent, { event: "scan" }>["reason"];

/**
 * Keeps the index current by rescanning a scope after relevant changes. Each
 * rescan reuses the transactional scope scan, so hashes skip unchanged notes,
 * deletions are applied only after a complete enumeration, and an unavailable
 * root preserves its last valid entries. The index guard is held per rescan.
 */
export async function watchNotes(config: Config, options: WatchOptions) {
  const {
    signal,
    report,
    debounceMs = 1000,
    maxWaitMs = 10_000,
    reconcileMs = 15 * 60_000,
    retryMs = 5000,
  } = options;
  const watchers = new Map<string, FSWatcher>();
  const attachTimers = new Map<string, NodeJS.Timeout>();
  const pending = new Map<string, Reason>();
  let firstPending = 0;
  let flushTimer: NodeJS.Timeout | undefined;
  let reconcileTimer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const relevant = (filename: string | null) => {
    if (filename === null) return true;
    const key = filename.split(path.sep).join("/");
    if (
      config.exclude.some(
        (pattern) =>
          path.matchesGlob(key, pattern) ||
          path.matchesGlob(`${key}/`, pattern),
      )
    )
      return false;
    const extension = path.extname(key).toLowerCase();
    // Directory events have no extension; renaming or deleting one can affect notes.
    return extension === ".md" || extension === "";
  };

  const schedule = (scopeIds: Iterable<string>, reason: Reason, delay = debounceMs) => {
    if (signal.aborted) return;
    if (!pending.size) firstPending = Date.now();
    for (const id of scopeIds)
      if (!pending.has(id) || reason !== "change") pending.set(id, reason);
    clearTimeout(flushTimer);
    const wait = Math.max(
      0,
      Math.min(delay, firstPending + maxWaitMs - Date.now()),
    );
    flushTimer = setTimeout(flush, wait);
  };

  const flush = () => {
    flushTimer = undefined;
    if (running || signal.aborted || !pending.size) return;
    const batch = new Map(pending);
    pending.clear();
    running = scan(batch).finally(() => {
      running = undefined;
      if (pending.size) schedule([], "change", 0);
    });
  };

  const scan = async (batch: Map<string, Reason>) => {
    const scopes = [...batch.keys()];
    try {
      // Loaded before taking the guard; a missing model leaves keyword indexing working.
      let embedder: Embedder | undefined;
      if (config.semantic)
        embedder =
          options.embedder ??
          (await getEmbedder(config.semantic).catch((error: Error) => {
            report({ event: "error", scopes, message: `Embeddings not updated: ${error.message}` });
            return undefined;
          }));
      let embedding: Awaited<ReturnType<typeof embedPending>> | undefined;
      const results = await withWriteSession(config, scopes, async (session) => {
        const { db } = session;
        const scanned = await indexNotes(session, config);
        if (embedder)
          embedding = await embedPending(db, embedder).catch((error: Error) => {
            report({ event: "error", scopes, message: `Embeddings not updated: ${error.message}` });
            return undefined;
          });
        return scanned;
      });
      // A watcher can keep following a root that was moved away (Windows does
      // not report it), so an unavailable root is reattached by path.
      for (const result of results)
        if (
          result.errors.some(
            (e) => e.code === "DIRECTORY_UNAVAILABLE" && e.relativePath === ".",
          )
        )
          reattach(result.scope, true);
      // Report one event per reason so callers can see why each scope ran.
      for (const reason of new Set(batch.values()))
        report({
          event: "scan",
          reason,
          results: results.filter((r) => batch.get(r.scope) === reason),
        });
      if (embedding?.embedded)
        report({
          event: "embedded",
          model: embedding.model,
          embedded: embedding.embedded,
          vectors: embedding.vectors,
          chunks: embedding.chunks,
        });
    } catch (error) {
      if (!(error instanceof IndexBusyError)) {
        // Not retried on a timer: a persistent failure such as a changed root
        // needs operator action. The next change or reconcile tries again.
        report({ event: "error", scopes, message: (error as Error).message });
        return;
      }
      for (const [id, reason] of batch)
        if (!pending.has(id)) pending.set(id, reason);
      report({ event: "busy", scopes, retryMs });
      if (!signal.aborted) {
        clearTimeout(flushTimer);
        firstPending = Date.now();
        flushTimer = setTimeout(flush, retryMs);
      }
    }
  };

  const detach = (id: string) => {
    watchers.get(id)?.close();
    watchers.delete(id);
  };

  const attach = (
    scope: Config["scopes"][number],
    recovering: boolean,
    announce = true,
  ) => {
    attachTimers.delete(scope.id);
    if (signal.aborted || watchers.has(scope.id)) return;
    const retry = (error: Error) => {
      detach(scope.id);
      report({
        event: "watch-error",
        scope: scope.id,
        message: (error as NodeJS.ErrnoException).code ?? error.message,
        retryMs,
      });
      if (!signal.aborted && !attachTimers.has(scope.id))
        attachTimers.set(
          scope.id,
          setTimeout(() => attach(scope, true), retryMs),
        );
    };
    try {
      const watcher = watch(scope.rootPath, { recursive: true }, (_, name) => {
        if (relevant(name)) schedule([scope.id], "change");
      });
      watcher.on("error", (error) => {
        retry(error);
        // Record the unavailable root; the scan keeps the last valid entries.
        schedule([scope.id], "change");
      });
      watchers.set(scope.id, watcher);
      if (announce)
        report({ event: "watching", scope: scope.id, root: scope.rootPath });
      // Changes made while the root was unwatched are picked up by a rescan.
      if (recovering) schedule([scope.id], "recovered", 0);
    } catch (error) {
      retry(error as Error);
    }
  };

  function reattach(id: string, recovering: boolean) {
    const scope = config.scopes.find((s) => s.id === id);
    if (!scope || attachTimers.has(id)) return;
    const wasWatching = watchers.has(id);
    detach(id);
    if (recovering)
      attachTimers.set(
        id,
        setTimeout(() => attach(scope, true), retryMs),
      );
    else attach(scope, false, !wasWatching);
  }

  // Watch before the startup scan so edits made during it are not lost.
  for (const scope of config.scopes) attach(scope, false);
  schedule(
    config.scopes.map((scope) => scope.id),
    "startup",
    0,
  );
  const code =
    options.code === false
      ? undefined
      : startCodeGraphRefresh(config, {
          report,
          debounceMs: options.codeDebounceMs,
          retryMs,
          build: options.codeBuild,
        });
  if (reconcileMs > 0)
    reconcileTimer = setInterval(() => {
      // Renew watchers so a replaced root directory is followed by path.
      for (const scope of config.scopes) reattach(scope.id, false);
      schedule(
        config.scopes.map((scope) => scope.id),
        "reconcile",
        0,
      );
      code?.reconcile();
    }, reconcileMs);

  await new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  clearTimeout(flushTimer);
  clearInterval(reconcileTimer);
  for (const timer of attachTimers.values()) clearTimeout(timer);
  for (const id of [...watchers.keys()]) detach(id);
  await Promise.all([running, code?.stop()]);
  report({ event: "stopped" });
}
