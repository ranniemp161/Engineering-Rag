import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

export type ScanError = { relativePath: string; code: string; message: string };

function sourcePath(root: string, key: string) {
  const candidate = path.resolve(root, key);
  const relative = path.relative(root, candidate);
  if (
    path.isAbsolute(key) ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Source path escapes its approved root");
  }
  return candidate;
}

export async function* markdownFiles(
  root: string,
  exclude: string[],
  errors: ScanError[],
  relative = "",
): AsyncGenerator<string> {
  const directory = sourcePath(root, relative);
  try {
    if (path.relative(directory, await realpath(directory)) !== "")
      throw new Error("Directory resolves outside its approved location");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        exclude.some(
          (pattern) =>
            path.matchesGlob(key, pattern) ||
            (entry.isDirectory() && path.matchesGlob(`${key}/`, pattern)),
        )
      )
        continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) yield* markdownFiles(root, exclude, errors, key);
      else if (
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === ".md"
      )
        yield key;
    }
  } catch (error) {
    errors.push({
      relativePath: relative || ".",
      code: "DIRECTORY_UNAVAILABLE",
      message:
        (error as NodeJS.ErrnoException).code ??
        "Cannot enumerate approved directory",
    });
  }
}

export async function readNote(root: string, relative: string) {
  const file = sourcePath(root, relative);
  if (path.relative(file, await realpath(file)) !== "")
    throw new Error("Source path changed during scan");
  const handle = await open(file, "r");
  try {
    const info = await handle.stat({ bigint: true });
    const actual = await lstat(file, { bigint: true });
    if (
      !info.isFile() ||
      info.ino !== actual.ino ||
      info.dev !== actual.dev ||
      path.relative(file, await realpath(file)) !== ""
    )
      throw new Error("Source identity changed during scan");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.mtimeNs !== info.mtimeNs || after.size !== BigInt(bytes.length))
      throw new Error("Source changed during read");
    return { bytes, modifiedAt: info.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}
