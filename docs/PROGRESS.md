# Project progress

## 2026-11-23

### Approved the embedded Turso design

The project directory initially contained no implementation or database to migrate. The revised specification selected the local-file TypeScript driver and native full-text index, updated the diagrams and schema requirements, and documented rebuilding a separate index from approved Markdown. An isolated probe confirmed exact cosine-distance support. Embeddings remain deferred. [Engineering specification](../ENGINEERING_INTELLIGENCE_SPEC.md)

### Verified scoped ranking and citations

On Windows x64 with Node 26.12.1 and Turso 0.8.4, a direct metadata join returned zero relevance scores. Materializing ranked chunk IDs before joining metadata preserved scores and allowed the scope filter to run before the result limit. Shared-only search, project-plus-shared search, empty results, and citation line mapping passed. A single-term benchmark on 1,000 synthetic documents and 10,000 chunks measured 5.34 ms warm SQL p95 over 100 queries. End-to-end MCP latency remains unmeasured. The tested query is in section 14 of the [specification](../ENGINEERING_INTELLIGENCE_SPEC.md).

### Resolved stale Windows reads in the compatibility fixture

A persistent reader missed another process's committed update. Four runs with an OS guard and a fresh connection per operation passed freshness, bounded waiting, and forced-process-exit checks. The implementation decision is to acquire the guard before opening Turso and release it after closing the connection. The application integration and Node 24 verification are pending.

### Completed Milestone 0

Added the TypeScript scaffold, package scripts and lockfile, example configuration, local configuration loader, fixture tests, and setup instructions. On Windows with Node 24.22.3 and pnpm 12.16.1, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` passed. All five tests passed, including a Windows junction pointing into a source root. Source and compiled configuration commands accepted a valid fixture and exited with code 1 for a missing configuration. [Setup](../README.md) · [Loader](../src/config/load-config.ts) · [Tests](../tests/load-config.test.ts)

### Established the contributor handoff

Added the root agent guide covering milestone boundaries, read-only vault access, and the Windows database decision. Verified the guide's links and package-script references. Added a current status page and this dated history, backfilled the completed work, and linked both from the contributor entry points. [Agent guide](../AGENTS.md) · [Current status](STATUS.md)

### Completed Milestone 1

Integrated the embedded Turso driver, native FTS schema migration, and persistent OS guard. The CLI scans each configured scope in a transaction, stores source text, title, tags, hash and cited chunks, and rebuilds all scopes in a single transaction. In indexing mode an unavailable root produces a recorded partial scan. Explicit configuration validation still requires all roots to exist. [Storage and schema](../src/storage/turso.ts) · [Configuration loader](../src/config/load-config.ts) · [CLI](../src/cli.ts)

The reader enforces canonical containment and skips links and configured exclusions. Chunking tracks heading ancestry, fenced blocks, and source lines. The incremental index keeps stable document IDs and removes stale documents only after successful directory enumeration. [Reader](../src/filesystem/markdown-reader.ts) · [Chunker](../src/markdown/chunk-markdown.ts) · [Indexer](../src/indexing/index-service.ts)

On Windows x64 with Node 24.22.3, the native locking probe passed reader freshness, contention, and recovery after forced termination. The application suite verified create/change/delete, unchanged rescans, source hash and modification-time preservation, FTS replacement, failed-scope isolation, rollback of an incomplete rebuild, status, and busy reporting. A successful rebuild resets scan history. A changed root for an existing scope requires an explicit rebuild.

`pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, and `pnpm test` passed (7 tests). A separate synthetic fixture passed `pnpm dev -- index`, `node dist/cli.js status`, and `node dist/cli.js rebuild`. The CLI, test discovery, and operator documentation are updated. Ranked search against the application schema is the next milestone. [Tests](../tests/index.test.ts) · [Commands](../README.md)
