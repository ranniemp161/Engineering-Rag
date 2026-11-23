import { mkdir } from "node:fs/promises";
import type { Config } from "../config/load-config.ts";

export type SemanticConfig = NonNullable<Config["semantic"]>;

/** Produces unit-length vectors; identical inputs must give identical output. */
export interface Embedder {
  model: string;
  embed(texts: string[], kind: "query" | "passage"): Promise<Float32Array[]>;
}

// Retrieval prefixes recommended by each model's authors. Configured prefixes win.
const KNOWN_PREFIXES: Record<string, { query: string; passage: string }> = {
  "Xenova/bge-small-en-v1.5": {
    query: "Represent this sentence for searching relevant passages: ",
    passage: "",
  },
  "Xenova/bge-base-en-v1.5": {
    query: "Represent this sentence for searching relevant passages: ",
    passage: "",
  },
  "Xenova/multilingual-e5-small": { query: "query: ", passage: "passage: " },
  "Xenova/all-MiniLM-L6-v2": { query: "", passage: "" },
};

const PACKAGE = "@huggingface/transformers";

/** Minimal surface of the optional transformers.js dependency. */
interface Transformers {
  env: {
    cacheDir: string;
    localModelPath: string;
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
  };
  pipeline(
    task: "feature-extraction",
    model: string,
    options: { dtype: string },
  ): Promise<
    (
      texts: string[],
      options: { pooling: "mean"; normalize: true },
    ) => Promise<{ dims: number[]; data: Float32Array }>
  >;
}

// Diagnostics may reach an MCP host, so they name commands, not local paths.
export class SemanticUnavailableError extends Error {}

async function loadTransformers(): Promise<Transformers> {
  try {
    // A variable specifier keeps the package optional for keyword-only installs.
    const specifier: string = PACKAGE;
    return (await import(specifier)) as Transformers;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND")
      throw new SemanticUnavailableError(
        `Semantic search needs the optional ${PACKAGE} dependency. Install it with pnpm, or remove "semantic" from the configuration.`,
      );
    throw error;
  }
}

async function createEmbedder(
  semantic: SemanticConfig,
  allowDownload: boolean,
): Promise<Embedder> {
  const transformers = await loadTransformers();
  transformers.env.cacheDir = semantic.modelDir;
  // Offline loading needs local models enabled; confine them to the model directory.
  transformers.env.localModelPath = semantic.modelDir;
  transformers.env.allowLocalModels = true;
  // Normal operation never contacts the network; only `fetch-model` may download.
  transformers.env.allowRemoteModels = allowDownload;
  if (allowDownload) await mkdir(semantic.modelDir, { recursive: true });
  let extract: Awaited<ReturnType<Transformers["pipeline"]>>;
  try {
    extract = await transformers.pipeline("feature-extraction", semantic.model, {
      dtype: "q8",
    });
  } catch (error) {
    if (allowDownload) throw error;
    // The cause can name local paths, so it goes to stderr rather than to a host.
    console.error(`Embedding model load failed: ${(error as Error).message}`);
    throw new SemanticUnavailableError(
      `Embedding model ${semantic.model} is not available offline. Run the fetch-model command once.`,
    );
  }
  const prefixes = KNOWN_PREFIXES[semantic.model] ?? { query: "", passage: "" };
  const prefix = {
    query: semantic.queryPrefix ?? prefixes.query,
    passage: semantic.passagePrefix ?? prefixes.passage,
  };
  return {
    model: semantic.model,
    async embed(texts, kind) {
      if (!texts.length) return [];
      const output = await extract(
        texts.map((t) => prefix[kind] + t),
        { pooling: "mean", normalize: true },
      );
      const width = output.dims.at(-1) ?? 0;
      return texts.map((_, i) =>
        Float32Array.from(output.data.subarray(i * width, (i + 1) * width)),
      );
    },
  };
}

const cache = new Map<string, Promise<Embedder>>();

/** Loads the configured model from the local cache, once per process. */
export function getEmbedder(semantic: SemanticConfig): Promise<Embedder> {
  const key = JSON.stringify([
    semantic.model,
    semantic.modelDir,
    semantic.queryPrefix,
    semantic.passagePrefix,
  ]);
  let embedder = cache.get(key);
  if (!embedder) {
    embedder = createEmbedder(semantic, false);
    // Retry after a failure, for example once the model has been fetched.
    embedder.catch(() => cache.delete(key));
    cache.set(key, embedder);
  }
  return embedder;
}

/** Downloads the configured model into the model directory. */
export async function fetchModel(semantic: SemanticConfig) {
  const embedder = await createEmbedder(semantic, true);
  const [vector] = await embedder.embed(["model check"], "passage");
  return {
    model: semantic.model,
    modelDir: semantic.modelDir,
    dimensions: vector?.length ?? 0,
  };
}

export const toBlob = (vector: Float32Array) =>
  Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
