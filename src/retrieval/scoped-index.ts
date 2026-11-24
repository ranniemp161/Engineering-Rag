import type { Config } from "../config/load-config.ts";
import {
  IndexError,
  type IndexSession,
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
  const scopeId = projectId ?? "shared";
  return withReadSession(config, [...new Set(["shared", scopeId])], (session) =>
    read(session, scopeId),
  );
}
