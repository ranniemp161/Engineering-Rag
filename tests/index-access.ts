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
