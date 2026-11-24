// Local read-only browser viewer for the index. Run `pnpm viewer`.
import { exec } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config/load-config.ts";
import {
  compareReports,
  loadEvalCases,
  readReport,
  runEvaluation,
} from "../evaluation/evaluate.ts";
import { indexStatus } from "../indexing/index-service.ts";
import { getDocument } from "../retrieval/get-document.ts";
import { getRelatedDocuments } from "../retrieval/related.ts";
import { searchKnowledge } from "../retrieval/search-service.ts";
import {
  IndexBusyError,
  IndexError,
  withReadSession,
} from "../storage/index-session.ts";
import { z } from "zod";
import { PAGE } from "./page.ts";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg) => arg !== "--"),
  options: {
    port: { type: "string", default: process.env.PORT ?? "4317" },
    "no-open": { type: "boolean" },
    eval: {
      type: "string",
      default:
        process.env.ENGINEERING_INTELLIGENCE_EVAL ?? "evaluation.local.json",
    },
    baseline: { type: "string" },
  },
});
const evalFile = path.resolve(values.eval);
const baselineFile = values.baseline && path.resolve(values.baseline);
const port = Number(values.port);
// Port 0 lets the OS choose a free port; the ready line reports the bound one.
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("--port must be an integer from 0 to 65535");

async function api(route: string, query: URLSearchParams) {
  const config = await loadConfig(undefined, { allowUnavailableRoots: true });
  const projectId = query.get("project") || undefined;
  const number = (name: string) =>
    query.get(name) ? Number(query.get(name)) : undefined;
  if (route === "/api/overview")
    return withReadSession(
      config,
      config.scopes.map((scope) => scope.id),
      async (session) => ({
      scopes: config.scopes.map(({ id, displayName, type }) => ({
        id,
        name: displayName,
        type,
      })),
      status: await indexStatus(session),
      documents: await session.db.all(
        `SELECT d.id, d.scope_id AS scope, d.relative_path AS path, d.title,
                (SELECT COUNT(*) FROM chunks c WHERE c.document_id = d.id) AS chunks
         FROM documents d ORDER BY d.scope_id, d.relative_path`,
      ),
      }),
    );
  if (route === "/api/search")
    return searchKnowledge(config, {
      query: query.get("q") ?? "",
      projectId,
      limit: number("limit") ?? config.search.maxLimit,
    });
  if (route === "/api/eval") {
    const report = await runEvaluation(
      config,
      await loadEvalCases(evalFile, config),
      evalFile,
    );
    const baseline = baselineFile ? await readReport(baselineFile) : undefined;
    return {
      ...report,
      comparison: baseline ? compareReports(baseline, report) : undefined,
    };
  }
  if (route === "/api/related")
    return getRelatedDocuments(config, {
      documentId: query.get("id") ?? "",
      projectId,
      limit: 50,
    });
  if (route === "/api/doc")
    return getDocument(config, {
      documentId: query.get("id") ?? "",
      projectId,
      startLine: number("start") ?? 1,
      maxLines: 200,
    });
  return undefined;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    const data = await api(url.pathname, url.searchParams);
    if (data === undefined) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (error) {
    const { status, message } = publicError(error);
    if (status === 500) console.error("Viewer request failed:", error);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: message }));
  }
});

/**
 * Maps a request failure to what the browser may see. Invalid input and index
 * errors are the caller's to act on (a busy index is a retryable 503); anything else may carry paths or SQL, so
 * it gets a generic message and its details go to stderr.
 */
function publicError(error: unknown) {
  if (error instanceof z.ZodError)
    return {
      status: 400,
      message: `Invalid request: ${error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; ")}`,
    };
  // A busy index clears once the other operation finishes, so it is retryable.
  if (error instanceof IndexBusyError) return { status: 503, message: error.message };
  if (error instanceof IndexError) return { status: 400, message: error.message };
  return { status: 500, message: "Request failed. Check the viewer diagnostics." };
}

server.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, "127.0.0.1", () => {
  const bound = server.address();
  const address = `http://127.0.0.1:${typeof bound === "object" && bound ? bound.port : port}`;
  console.error(`Engineering index viewer: ${address} (Ctrl+C to stop)`);
  if (values["no-open"]) return;
  const opener =
    process.platform === "win32"
      ? `start "" "${address}"`
      : process.platform === "darwin"
        ? `open "${address}"`
        : `xdg-open "${address}"`;
  exec(opener, () => {});
});
