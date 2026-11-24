# Glossary

Domain terms for the Engineering Intelligence Engine. Use these words in code, tests, issues and reviews.

**Scope**: a named set of approved Markdown notes. `shared` holds knowledge for every project; each project scope holds one project's notes. _Avoid_: vault (a vault is where notes live, not how they are partitioned).

**Scope root**: the operator-approved folder a scope indexes. The index records each scope's root, and a moved root needs a rebuild.

**Index session**: one guarded use of the local index, read or write, opened through `src/storage/index-session.ts`. It owns the lock, schema upgrade and scope root checks, so callers never open the database directly.

**Index capability**: a schema feature an index session reports, such as `embeddings` or `references`. Older indexes opened read-only lack newer capabilities until the next write upgrades them. _Avoid_: schema version (internal to the index session).

**Index refresh**: one update of the index: scan the requested scopes (all, named ones, or a rebuild of every scope), then embed new passages when semantic search is configured. `refreshIndex` in `src/indexing/index-service.ts` is the only way to run one; the `index` and `rebuild` commands and the watcher all call it. Scan errors and embedding failures are part of its result, not exceptions.
