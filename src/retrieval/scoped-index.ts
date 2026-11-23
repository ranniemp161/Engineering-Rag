import type { Database } from "@tursodatabase/database";
import { access } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/load-config.ts";
import { migrate, withIndex } from "../storage/turso.ts";

// Messages of this type may be returned to the MCP host. Keep paths and SQL private.
export class RetrievalError extends Error {}

export async function withScopedIndex<T>(
  config: Config,
  projectId: string | undefined,
  read: (db: Database, scopeId: string) => Promise<T>,
): Promise<T> {
  if (
    projectId !== undefined &&
    !config.scopes.some((s) => s.type === "project" && s.id === projectId)
  )
    throw new RetrievalError("Unknown project ID");
  await access(config.databasePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT")
      throw new RetrievalError("Index missing. Run the index command first.");
    throw error;
  });
  return withIndex(config.databasePath, true, async (db) => {
    await migrate(db, true);
    const scopeId = projectId ?? "shared";
    for (const row of await db.all(
      "SELECT id,root_path FROM scopes WHERE id IN ('shared',?)",
      scopeId,
    )) {
      const scope = config.scopes.find((s) => s.id === row.id);
      if (!scope || path.relative(scope.rootPath, row.root_path) !== "")
        throw new RetrievalError(
          "Indexed scope root has changed. Rebuild the index.",
        );
    }
    return read(db, scopeId);
  });
}
