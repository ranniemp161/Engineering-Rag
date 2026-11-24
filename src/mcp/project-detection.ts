import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/load-config.ts";

function contains(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Maps the host's working directories to one configured project. A directory
 * matches a project when it lies inside the project's note root or one of its
 * listed repositories. Several matching projects, or none, select no project,
 * so an ambiguous workspace never widens a search beyond shared notes.
 */
export async function detectProject(
  config: Config,
  workingDirectories: string[],
): Promise<string | undefined> {
  const matches = new Set<string>();
  for (const directory of workingDirectories) {
    const canonical = await realpath(directory).catch(() => path.resolve(directory));
    for (const scope of config.scopes) {
      if (scope.type !== "project") continue;
      const roots = [scope.rootPath, ...(scope.repositories ?? [])];
      if (roots.some((root) => contains(root, canonical))) matches.add(scope.id);
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}
