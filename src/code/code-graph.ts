import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config/load-config.ts";
import { RetrievalError } from "../retrieval/scoped-index.ts";

/**
 * Reads a Graphify (graphifyy 0.9.x) `graph.json`: NetworkX node-link data with
 * `nodes` (id, label, source_file, source_location "L12") and `links`
 * (source, target, relation, confidence, source_file, source_location). Edges
 * are read as directed from source to target, as Graphify's own tools do.
 */

// Graphify's DEFAULT_AFFECTED_RELATIONS: edges along which a change propagates.
export const IMPACT_RELATIONS = [
  "calls",
  "indirect_call",
  "references",
  "imports",
  "imports_from",
  "dynamic_import",
  "re_exports",
  "inherits",
  "extends",
  "implements",
  "uses",
  "mixes_in",
  "embeds",
  "defines",
  "requires",
] as const;
const MEMBER_RELATIONS = new Set(["method", "contains"]);

interface RawNode {
  id: string;
  label?: string;
  source_file?: string;
  source_location?: string;
}
interface RawLink {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  source_file?: string;
  source_location?: string;
}

export interface CodeNode {
  nodeId: string;
  label: string;
  kind: "file" | "function" | "method" | "symbol";
  path: string | null;
  line: number | null;
}

interface LoadedGraph {
  builtAt: string;
  nodes: Map<string, CodeNode>;
  outgoing: Map<string, RawLink[]>;
  incoming: Map<string, RawLink[]>;
}

const cache = new Map<string, { key: string; graph: LoadedGraph }>();

const lineOf = (location: string | undefined) => {
  const match = /^L(\d+)/.exec(location ?? "");
  return match ? Number(match[1]) : null;
};

/** Repository-relative POSIX path; absolute paths are never returned to a host. */
function relativePath(file: string | undefined, repository: string) {
  if (!file) return null;
  const native = file.replace(/[\\/]/g, path.sep);
  const relative = path.isAbsolute(native) ? path.relative(repository, native) : native;
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

function kindOf(label: string, file: string | null): CodeNode["kind"] {
  // Graphify prefixes duplicate file names with folders, as in "test/x.test.ts".
  if (file && (label === file || file.endsWith(`/${label}`) || label === path.posix.basename(file)))
    return "file";
  if (label.endsWith("()")) return label.startsWith(".") ? "method" : "function";
  return "symbol";
}

export function codeGraphFor(config: Config, projectId: string | undefined) {
  if (!projectId)
    throw new RetrievalError("Code graph tools need a projectId (or a detected project).");
  const scope = config.scopes.find((s) => s.type === "project" && s.id === projectId);
  if (!scope) throw new RetrievalError("Unknown project ID");
  if (!scope.codeGraph)
    throw new RetrievalError("No code graph is configured for this project.");
  // loadConfig resolves the repository default, so both paths are set here.
  return scope.codeGraph as { repository: string; output: string; visualize?: boolean };
}

async function loadGraph(config: Config, projectId: string | undefined) {
  const settings = codeGraphFor(config, projectId);
  const file = path.join(settings.output, "graph.json");
  const info = await stat(file).catch(() => {
    throw new RetrievalError("Code graph missing. Run the code-build command first.");
  });
  const key = `${info.mtimeMs}:${info.size}`;
  const cached = cache.get(file);
  if (cached?.key === key)
    return { graph: cached.graph, repository: settings.repository };
  let raw: { nodes?: RawNode[]; links?: RawLink[]; edges?: RawLink[] };
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new RetrievalError("Code graph is unreadable. Rebuild it with code-build.");
  }
  const parsed = z
    .object({ nodes: z.array(z.object({ id: z.string() }).passthrough()) })
    .safeParse(raw);
  if (!parsed.success)
    throw new RetrievalError("Code graph has an unexpected format. Rebuild it with code-build.");
  const nodes = new Map<string, CodeNode>();
  for (const node of raw.nodes ?? []) {
    const file = relativePath(node.source_file, settings.repository);
    const label = String(node.label ?? node.id);
    nodes.set(node.id, {
      nodeId: node.id,
      label,
      kind: kindOf(label, file),
      path: file,
      line: lineOf(node.source_location),
    });
  }
  const outgoing = new Map<string, RawLink[]>();
  const incoming = new Map<string, RawLink[]>();
  for (const link of raw.links ?? raw.edges ?? []) {
    if (!nodes.has(link.source) || !nodes.has(link.target)) continue;
    outgoing.set(link.source, [...(outgoing.get(link.source) ?? []), link]);
    incoming.set(link.target, [...(incoming.get(link.target) ?? []), link]);
  }
  const graph = { builtAt: info.mtime.toISOString(), nodes, outgoing, incoming };
  cache.set(file, { key, graph });
  return { graph, repository: settings.repository };
}

const words = (text: string) =>
  (text.match(/[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+/g) ?? []).map((w) =>
    w.toLowerCase(),
  );

export const codeSearchInput = z.strictObject({
  query: z.string().min(1).max(256),
  projectId: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

/**
 * Finds code nodes by name. Words are split on case and punctuation, so
 * "applySale" matches "apply sale". An exact name ranks first; ties prefer
 * the more connected node, then the label.
 */
export async function searchCodeGraph(config: Config, input: unknown) {
  const { query, projectId, limit = 10 } = codeSearchInput.parse(input);
  const { graph } = await loadGraph(config, projectId);
  const wanted = [...new Set(words(query))];
  if (!wanted.length) throw new RetrievalError("Search requires at least one word");
  const exact = query.trim().toLowerCase().replace(/\(\)$/, "").replace(/^\./, "");
  const scored = [];
  for (const node of graph.nodes.values()) {
    const name = node.label.toLowerCase().replace(/\(\)$/, "").replace(/^\./, "");
    const nameWords = new Set(words(node.label));
    const pathWords = new Set(words(node.path ?? ""));
    let score = name === exact ? 10 : 0;
    for (const word of wanted) {
      if (nameWords.has(word)) score += 3;
      else if (name.includes(word)) score += 2;
      else if (pathWords.has(word)) score += 1;
    }
    if (!score) continue;
    const dependents = (graph.incoming.get(node.nodeId) ?? []).length;
    const dependencies = (graph.outgoing.get(node.nodeId) ?? []).length;
    scored.push({ ...node, dependents, dependencies, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.dependents + b.dependencies - (a.dependents + a.dependencies) ||
      a.label.localeCompare(b.label),
  );
  return {
    projectId,
    graphBuiltAt: graph.builtAt,
    total: scored.length,
    results: scored.slice(0, limit),
  };
}

const plainName = (text: string) =>
  text.trim().toLowerCase().replace(/\(\)$/, "").replace(/^\./, "");

/**
 * Accepts a node ID or an exact name: a function, method or type name with or
 * without "()", or a repository-relative file path. A name shared by several
 * nodes is reported with its candidates rather than guessed.
 */
function resolveNode(graph: LoadedGraph, reference: string): CodeNode {
  const direct = graph.nodes.get(reference);
  if (direct) return direct;
  const wanted = plainName(reference);
  const matches = [...graph.nodes.values()].filter(
    (node) => plainName(node.label) === wanted || node.path?.toLowerCase() === wanted,
  );
  // A file path names the file node, not every symbol declared in it.
  const files = matches.filter((node) => node.kind === "file" && node.path?.toLowerCase() === wanted);
  const candidates = files.length === 1 ? files : matches;
  if (candidates.length === 1) return candidates[0] as CodeNode;
  if (!candidates.length)
    throw new RetrievalError("Unknown code node. Use search_code_graph first.");
  const listed = candidates
    .slice(0, 5)
    .map((node) => `${node.nodeId} (${node.path ?? "?"}:${node.line ?? "?"})`)
    .join(", ");
  throw new RetrievalError(
    `"${reference}" matches ${candidates.length} code nodes; pass one nodeId: ${listed}`,
  );
}

export const codeImpactInput = z.strictObject({
  nodeId: z.string().min(1).max(512),
  projectId: z.string().min(1).optional(),
  direction: z.enum(["dependents", "dependencies"]).optional(),
  depth: z.number().int().min(1).max(4).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

/**
 * Walks dependency edges from a node. `dependents` (the default) reverses the
 * edges like Graphify's `affected`: who calls, imports, references or derives
 * from this node, i.e. what a change here can break. `dependencies` follows
 * them forward. The node's own methods and contained symbols seed the walk
 * but are not reported. Each hit cites the edge's call or import site.
 */
export async function getCodeImpact(config: Config, input: unknown) {
  let {
    nodeId,
    projectId,
    direction = "dependents",
    depth = 2,
    limit = 50,
  } = codeImpactInput.parse(input);
  const { graph, repository } = await loadGraph(config, projectId);
  const root = resolveNode(graph, nodeId);
  nodeId = root.nodeId;
  const relations = new Set<string>(IMPACT_RELATIONS);
  const seen = new Set([nodeId]);
  const queue: [string, number][] = [[nodeId, 0]];
  for (const link of graph.outgoing.get(nodeId) ?? [])
    if (MEMBER_RELATIONS.has(link.relation ?? "") && !seen.has(link.target)) {
      seen.add(link.target);
      queue.push([link.target, 0]);
    }
  const hits = [];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const [current, level] = next;
    if (level >= depth) continue;
    const edges =
      direction === "dependents"
        ? graph.incoming.get(current) ?? []
        : graph.outgoing.get(current) ?? [];
    for (const link of edges) {
      if (!relations.has(link.relation ?? "")) continue;
      const other = direction === "dependents" ? link.source : link.target;
      if (seen.has(other)) continue;
      seen.add(other);
      const node = graph.nodes.get(other) as CodeNode;
      hits.push({
        ...node,
        depth: level + 1,
        relation: link.relation,
        confidence: link.confidence ?? null,
        via: {
          path: relativePath(link.source_file, repository),
          line: lineOf(link.source_location),
          from: direction === "dependents" ? other : current,
          to: direction === "dependents" ? current : other,
        },
      });
      queue.push([other, level + 1]);
    }
  }
  const result = {
    projectId,
    graphBuiltAt: graph.builtAt,
    node: root,
    direction,
    depth,
    total: hits.length,
    results: hits.slice(0, limit),
  };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new RetrievalError("Code impact exceeds the response size limit; lower limit or depth.");
  return result;
}
