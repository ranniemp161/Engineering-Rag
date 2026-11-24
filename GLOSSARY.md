# Glossary

Domain terms for the Engineering Intelligence Engine. Use these words in code, tests, issues and reviews.

**Scope**: a named set of approved Markdown notes. `shared` holds knowledge for every project; each project scope holds one project's notes. _Avoid_: vault (a vault is where notes live, not how they are partitioned).

**Scope root**: the operator-approved folder a scope indexes. The index records each scope's root, and a moved root needs a rebuild.

**Index session**: one guarded use of the local index, read or write, opened through `src/storage/index-session.ts`. It owns the lock, schema upgrade and scope root checks, so callers never open the database directly.

**Index capability**: a schema feature an index session reports, such as `embeddings` or `references`. Older indexes opened read-only lack newer capabilities until the next write upgrades them. _Avoid_: schema version (internal to the index session).
