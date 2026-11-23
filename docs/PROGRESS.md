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

### Completed Milestone 2

Added ranked local keyword search through the CLI and a reusable retrieval service. The query scores chunks before joining document metadata, filters eligible scopes before limiting, and skips duplicate excerpts from overlapping chunks. The service validates queries and configured limits, refuses unknown projects and remapped scope roots, and returns bounded snippets with indexed document IDs and line citations. [Service](../src/retrieval/search-service.ts) · [CLI](../src/cli.ts) · [Usage](../README.md)

The acceptance fixture gave an unrelated project the strongest match. Project A still received its highest eligible passage at limit one, and an unscoped query returned shared notes only. Checks covered citation fidelity, deduplication, empty results, malformed input, and missing indexes. Frozen install, build, typecheck, lint, and all eight tests passed. Verified both `pnpm dev -- search` and `node dist/cli.js search` with JSON output. [Search tests](../tests/search.test.ts)

The Windows x64 benchmark used Node 24.22.3 and 1,000 generated Markdown files, ten sections per file, indexed by the application across three scopes. The compiled retrieval service returned five eligible results per call. After ten warmups, 100 searches alternating shared and project scope with common and topic-specific terms measured **33.3 ms p95** against the 300 ms target. Timing included the uncontended guard, read-only connection lifecycle, schema and scope checks, ranking, and excerpt assembly. CLI process startup, configuration loading, and MCP transport were outside the timing. Milestone 3 will verify the MCP tool contracts.

### Completed Milestone 3

Pinned the official MCP TypeScript SDK at 1.32.2 and added a local stdio server. Search reuses the CLI service. Document retrieval queries the indexed source snapshot by stable document ID and permitted scope, returns an inclusive line citation, and caps the line count, text length, and JSON payload size. Both tools reload operator configuration on each call and share root checks and the read-only OS guard. [Server](../src/mcp/server.ts) · [Scoped index access](../src/retrieval/scoped-index.ts) · [Document reader](../src/retrieval/get-document.ts) · [Launch and response format](../README.md)

On Windows x64 with Node 24.22.3, an SDK client launched the server as a subprocess. It listed and invoked both tools, fetched source text by a search result ID, and verified default shared scope, project isolation, missing indexes, invalid paths and ranges, oversized lines, lock contention, reindex freshness and revocation of a configured project. The client reported zero protocol errors and the successful test run produced no server diagnostics. The frozen install, build, typecheck, lint, and all nine tests passed. Repeating the protocol suite with `TEST_COMPILED_MCP=1` and `node --test tests/mcp.test.ts` passed against the built server. A coding-host demonstration is pending for Milestone 4. [Integration test](../tests/mcp.test.ts)
