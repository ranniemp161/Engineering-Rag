import type { Config } from "../config/load-config.ts";
import {
  IndexError,
  type IndexSession,
  UnknownScopeError,
  withReadSession,
} from "../storage/index-session.ts";

// Messages of this type may be returned to the MCP host. Keep paths and SQL private.
export class RetrievalError extends IndexError {}

/** Opens a read session over shared knowledge plus the requested project. */
export async function withScopedIndex<T>(
  config: Config,
  projectId: string | undefined,
  read: (session: IndexSession, scopeId: string) => Promise<T>,
): Promise<T> {
  if (
    projectId !== undefined &&
    !config.scopes.some((s) => s.type === "project" && s.id === projectId)
  )
    throw new UnknownScopeError("Unknown project ID");
  const scopeId = projectId ?? "shared";
  return withReadSession(config, [...new Set(["shared", scopeId])], (session) =>
    read(session, scopeId),
  );
}
