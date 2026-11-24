import { loadConfig } from "../src/config/load-config.ts";
import { refreshIndex } from "../src/indexing/index-service.ts";
import {
  type IndexSession,
  withReadSession,
  withWriteSession,
} from "../src/storage/index-session.ts";

// Raw index access for assertions and fixture edits. No scope is root-checked.
const unscoped = (databasePath: string) => ({ databasePath, scopes: [] });

export const readIndex = <T>(
  databasePath: string,
  read: (session: IndexSession) => Promise<T>,
) => withReadSession(unscoped(databasePath), [], read);

export const writeIndex = <T>(
  databasePath: string,
  write: (session: IndexSession) => Promise<T>,
) => withWriteSession(unscoped(databasePath), [], write);

/**
 * Builds or refreshes the index for a configuration file in-process, failing
 * like the `index` command would on scan errors or an embedding failure.
 */
export async function buildIndex(configFile: string) {
  const config = await loadConfig(configFile, { allowUnavailableRoots: true });
  const result = await refreshIndex(config, { kind: "all" });
  const errors = result.scans.filter((scan) => scan.errors.length);
  if (errors.length || result.embedding.status === "failed")
    throw new Error(`Index build failed: ${JSON.stringify({ errors, embedding: result.embedding })}`);
  return result;
}
