import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const text = z.string().trim().min(1);
const limit = z.number().int().min(1).max(20);
const schema = z.strictObject({
  databasePath: text,
  scopes: z
    .array(
      z.strictObject({
        id: text,
        displayName: text,
        type: z.enum(["shared", "project"]),
        rootPath: text,
      }),
    )
    .min(1),
  exclude: z
    .array(text)
    .default([
      "**/.git/**",
      "**/.obsidian/**",
      "**/node_modules/**",
      "**/.env*",
    ]),
  search: z
    .strictObject({
      defaultLimit: limit.default(5),
      maxLimit: limit.default(20),
    })
    .prefault({}),
  // Optional hybrid retrieval. Omitting it keeps keyword-only search.
  semantic: z
    .strictObject({
      model: text.default("Xenova/bge-small-en-v1.5"),
      modelDir: text.default("./data/models"),
      queryPrefix: z.string().max(200).optional(),
      passagePrefix: z.string().max(200).optional(),
      keywordWeight: z.number().min(0).max(10).default(1),
      semanticWeight: z.number().min(0).max(10).default(1),
    })
    .optional(),
});

export type Config = z.infer<typeof schema>;

function localPath(base: string, value: string, field: string): string {
  const absoluteDrive =
    /^[A-Za-z]:[\\/]/.test(value) && process.platform === "win32";
  const hasScheme = /^[A-Za-z][A-Za-z\d+.-]*:/.test(value);
  if (
    !value.trim() ||
    value.includes("\0") ||
    /^[\\/]{2}/.test(value) ||
    value === ":memory:" ||
    (hasScheme && !absoluteDrive)
  ) {
    throw new Error(`${field} must be a local filesystem path`);
  }
  return path.resolve(base, value);
}

// Resolve existing ancestors without creating either the index or its directory.
async function canonicalDestination(file: string): Promise<string> {
  try {
    await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const directory = path.dirname(file);
    if (directory === file) throw error;
    const parent = await canonicalDestination(directory);
    return path.join(parent, path.basename(file));
  }
  return realpath(file);
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function loadConfig(
  location = process.env.ENGINEERING_INTELLIGENCE_CONFIG ?? "config.local.json",
  options: { allowUnavailableRoots?: boolean } = {},
): Promise<Config> {
  const file = localPath(process.cwd(), location, "Configuration location");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read JSON configuration at ${file}: ${(error as Error).message}`,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join(", ")}`,
    );
  }

  const config = parsed.data;
  if (config.search.defaultLimit > config.search.maxLimit) {
    throw new Error("search.defaultLimit exceeds search.maxLimit");
  }
  if (
    !config.scopes.some(
      (scope) => scope.id === "shared" && scope.type === "shared",
    )
  ) {
    throw new Error("Configure a shared scope with id and type 'shared'");
  }
  const base = path.dirname(file);
  const ids = new Set<string>();
  const roots: string[] = [];
  for (const scope of config.scopes) {
    if (ids.has(scope.id)) throw new Error(`Duplicate scope id: ${scope.id}`);
    ids.add(scope.id);
    if ((scope.type === "shared") !== (scope.id === "shared")) {
      throw new Error("Only the shared scope may use type 'shared'");
    }
    try {
      const root = await realpath(localPath(base, scope.rootPath, "rootPath"));
      scope.rootPath = localPath(base, root, "Resolved rootPath");
      if (!(await stat(root)).isDirectory())
        throw new Error("Expected a directory");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        options.allowUnavailableRoots &&
        ["ENOENT", "EACCES", "EPERM"].includes(code ?? "")
      ) {
        scope.rootPath = localPath(base, scope.rootPath, "rootPath");
      } else {
        throw new Error(
          `Invalid rootPath for ${scope.id}: ${(error as Error).message}`,
        );
      }
    }
    if (
      roots.some(
        (root) =>
          contains(root, scope.rootPath) || contains(scope.rootPath, root),
      )
    ) {
      throw new Error(`Overlapping scope roots at ${scope.rootPath}`);
    }
    roots.push(scope.rootPath);
  }

  try {
    const destination = await canonicalDestination(
      localPath(base, config.databasePath, "databasePath"),
    );
    config.databasePath = localPath(base, destination, "Resolved databasePath");
    const existing = await stat(destination).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    if (existing && !existing.isFile()) throw new Error("Expected a file path");
    if (
      path.relative(await realpath(file), destination) === "" ||
      roots.some((root) => contains(root, destination))
    ) {
      throw new Error(
        "Choose a database file outside source roots and separate from the configuration",
      );
    }
  } catch (error) {
    throw new Error(`Invalid databasePath: ${(error as Error).message}`);
  }
  if (config.semantic) {
    const semantic = config.semantic;
    try {
      const directory = await canonicalDestination(
        localPath(base, semantic.modelDir, "semantic.modelDir"),
      );
      semantic.modelDir = localPath(base, directory, "Resolved modelDir");
      if (roots.some((root) => contains(root, directory)))
        throw new Error("Choose a model directory outside source roots");
    } catch (error) {
      throw new Error(`Invalid semantic.modelDir: ${(error as Error).message}`);
    }
    if (semantic.keywordWeight + semantic.semanticWeight === 0)
      throw new Error("semantic weights cannot both be zero");
  }
  return config;
}
