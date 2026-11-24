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

### Completed Milestone 4

After a frozen install and build, `node dist/cli.js index` indexed one synthetic project note. Codex CLI 0.171.0 launched the compiled MCP server with Node 24.22.3 using temporary per-run settings. Its JSON events recorded successful `search_engineering_knowledge` and `get_document` calls in that order. The final answer correctly cited line 3 of `decisions/offline-retries.md` for local queuing and line 4 for the 47-second retry. The host exited successfully. Typecheck, lint, and all nine tests also passed.

Added a verified host configuration and repeatable fixture exercise, linked them from the README, and updated the project status. The fixture satisfied host acceptance without accessing an operator vault. Real-note onboarding remains optional. [Host walkthrough](CODEX_HOST.md) · [Status](STATUS.md)

### Indexed the first real project

Configured the operator-approved GroceryOS repository as a project scope in the ignored local configuration, with an empty shared folder. Dependency directories, build output and tool caches were excluded. `pnpm config:check` passed. The local CLI indexed 53 Markdown files into 447 chunks without errors. A search for `inventory` returned a project passage whose cited lines were checked against the source file. The same query in shared scope returned zero results. A second index run skipped all 53 unchanged documents. [Current status](STATUS.md)

### Verified GroceryOS retrieval in VS Code

The operator's Codex chat screenshot showed Engineering search followed by document retrieval for a GroceryOS offline oversell question. Checked the answer against Decision 0020 line 5 and lines 14–16 in the source checkout. Both citations supported the claims. [Current status](STATUS.md)

### Added a local index viewer

Added `pnpm viewer`, a read-only page on 127.0.0.1 that opens in the default browser. It lists indexed documents per scope, runs scoped searches and shows cited documents with line numbers. It reuses `searchKnowledge`, `getDocument` and `indexStatus` and takes the guarded read-only connection for each request. Generic SQLite viewers report the database as malformed because they cannot parse Turso's `USING fts` index, so this gives operators a supported way to inspect it. Files: `src/viewer/server.ts`, `src/viewer/page.ts`, `package.json` and README. Typecheck, lint and build passed. Against the GroceryOS index, the HTTP endpoints listed 53 documents, returned 15 project hits for `oversell` and read a cited document. A request for a project document without the project ID was rejected with `Document unavailable in the requested scope`. The page was not exercised in a browser, and no automated test covers the viewer yet. [README](../README.md#browse-the-index)

### Completed Milestone 5: automatic index refresh

The operator chose automatic refresh as the first post-MVP milestone and deferred automatic project detection. Added Milestone 5 to the specification with its exit criteria.

Added `watch` to the CLI. It watches each configured root recursively, ignores excluded paths and files other than Markdown, and debounces changes per scope (1 s quiet period, 10 s maximum wait). Affected scopes are rescanned through the existing transactional scan, now restricted by an optional scope filter on `indexNotes`. The guard is held only during a rescan. A busy index is retried after 5 s. Other failures are reported and wait for the next change or reconciliation. Missing roots are reattached when they appear, and a root found unavailable is reattached by path. A Windows probe showed that a watcher follows a root that has been moved away, without an event or error. Reconciliation (default 15 minutes) therefore renews watchers before rescanning every scope. Events are printed as JSON lines. Files: `src/indexing/watch-service.ts`, `src/indexing/index-service.ts`, `src/cli.ts`, `tests/watch.test.ts`, README and specification.

Checks on Windows x64 with Node 26.12.1 (the project pins 24.x, which was not available in this session): typecheck, lint, build, and all 12 tests passed. The three new watch tests passed in four consecutive runs. Against the approved GroceryOS scope, the source and built `watch` commands attached to both roots, completed a startup scan (53 unchanged, no errors) and produced no stderr. The scheduled-task example in the README was not registered or run. Recursive watching of a large repository on Linux, where each directory uses an inotify watch, has not been measured. [Watch tests](../tests/watch.test.ts) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md#milestone-5--automatic-index-refresh-post-mvp)

## 2026-11-24

### Completed Milestone 6: retrieval evaluation

Moved on to the next post-MVP milestone without naming one, so retrieval evaluation was taken next: the specification requires its evidence before hybrid retrieval. Added Milestone 6 to the specification.

Added `eval` to the CLI. It loads operator-local cases (`evaluation.local.json`, now ignored by Git, with a committed placeholder `evaluation.example.json`) and rejects duplicate IDs, unconfigured projects and expected scopes a search cannot reach. It runs each case through `searchKnowledge` at the configured maximum limit and reports hit@1/3/5/20, MRR, recall@5 and latency percentiles, overall, per tag and per project, with each case's rank and top results. `--output` saves a report. `--baseline` reports deltas, added and removed cases, improvements and regressions (a case that falls out of the top 5) and exits with code 1 on a regression. The viewer gained an Evaluate view with the same report and comparison. Files: `src/evaluation/evaluate.ts`, `src/cli.ts`, `src/viewer/server.ts`, `src/viewer/page.ts`, `tests/eval.test.ts`, `evaluation.example.json`, `.gitignore`, README and specification.

Also fixed garbled characters in the viewer page committed in `9f4f030`: `…`, `·` and `–` had been double-encoded when the page was extracted with PowerShell. A test now checks for the garbled sequences.

Recorded a local GroceryOS baseline of 26 cases (12 keyword, 14 paraphrase) in the ignored `data/eval-baseline.json`. Expected documents were chosen from decision-record titles. Overall: hit@1 0.462, hit@5 0.769, hit@20 0.846, MRR 0.588, p95 latency 13.5 ms. Keyword cases: hit@5 1.0, MRR 0.875. Paraphrase cases: hit@5 0.571, MRR 0.342. Four paraphrases found no expected document in 20 results (decisions 0004, 0007, 0009 and 0015). Rerunning against the baseline with the CLI and the built viewer reported no regressions.

Checks on Node 26.12.1: typecheck, lint, build and all 15 tests passed. The new evaluation tests passed in three runs. The viewer's inline script was parsed with Node, and its endpoints were exercised over HTTP, but the Evaluate view was not opened in a browser. [Evaluation tests](../tests/eval.test.ts) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md#milestone-6--retrieval-evaluation-post-mvp)

### Built Milestone 7: hybrid retrieval (dependency install pending)

Added optional hybrid retrieval, specified as Milestone 7.
- **Probe of Turso 0.8.4:** `vector32` and `vector_distance_cos` work, Float32 blob binding works, chunk deletion cascades to vectors, and an exact scan of 10,000 × 384 vectors took about 24 ms. `libsql_vector_idx` failed to parse, so no approximate index is used.
- **Probe of `@huggingface/transformers` 4.3.2** (installed only in a scratch folder): its install scripts were skipped and it still ran on Windows. A cached model loaded offline in about 0.3 s. A model that was not cached failed immediately with remote access disabled.
- **Configuration:** an optional `semantic` section with validated `modelDir` and weights.
- **Embedder:** loaded through a variable dynamic import so the dependency stays optional. Only `fetch-model` may download.
- **Schema version 2:** adds `chunk_embeddings`. Version 1 indexes upgrade on write and stay searchable read-only.
- **Embedding:** `embedPending` runs after scans in `index`, `rebuild` and `watch`, in batches that each commit, re-embeds only new chunks and replaces vectors when the model changes.
- **Search:** weighted Reciprocal Rank Fusion over 50 scoped keyword and 50 scoped exact-cosine candidates. Default searches fall back to keywords when no embedder or vectors exist; `--mode hybrid` fails instead.
- **Reporting:** `--mode` on `search` and `eval`, mode and model in reports, and vectors per scope and model in `status`.

Files: `src/semantic/embedder.ts`, `src/semantic/embed-index.ts`, `src/retrieval/search-service.ts`, `src/storage/turso.ts`, `src/config/load-config.ts`, `src/indexing/index-service.ts`, `src/indexing/watch-service.ts`, `src/evaluation/evaluate.ts`, `src/cli.ts`, `tests/semantic.test.ts`, README and specification.

**Measurement.** The scratch copy of transformers ran the GroceryOS evaluation on a scratch index built read-only from the approved scope. It used the project's indexing, embedding and evaluation code with a scratch embedder adapter. The real index was not modified. Keyword baseline: hit@5 0.769, MRR 0.588.

| Model, weights (keyword:semantic) | hit@1 | hit@5 | hit@20 | MRR | Top-5 regressions |
|---|---|---|---|---|---|
| `bge-small-en-v1.5`, 1:1 | 0.654 | 0.885 | 0.962 | 0.755 | none |
| `bge-small-en-v1.5`, 1:2 | 0.692 | 0.885 | 0.962 | 0.785 | none |
| `all-MiniLM-L6-v2`, 1:1 | 0.615 | 0.885 | 1.0 | 0.744 | none |
| `multilingual-e5-small`, 1:1 | 0.692 | 0.846 | 0.923 | 0.744 | pa-login, 5 to 18 |

- With `bge-small-en-v1.5` at 1:1, keyword-case hit@1 rose from 0.75 to 1.0 and paraphrase hit@5 from 0.571 to 0.786.
- Two of the four former misses entered the top 5 (decisions 0007 and 0009). The other two now rank 10 and 13.
- `pa-tingi` fell from rank 10 to outside the top 20; `multilingual-e5-small` and `all-MiniLM-L6-v2` ranked it 4 and 2.
- Embedding 447 chunks took about 41 s. p95 query latency, including query embedding, was 45–55 ms.
- Chose `bge-small-en-v1.5` at 1:1 as the default. The 1:2 result is documented, not made the default: the 26 cases are few and were written from decision titles.

**Checks** on Node 26.12.1: typecheck, lint, build and all 20 tests passed. The new semantic tests run offline with a deterministic fake embedder.

**Blocked.** Adding `@huggingface/transformers@4.3.2` to `package.json` with `pnpm add` was denied by the session's permission classifier, and was not attempted another way. The operator needs to run the install. After the install, still to do:
- Run `fetch-model` and re-index.
- Rerun the real evaluation through the project and update the GroceryOS baseline.
- Confirm the MCP server in a host.
- Check pnpm's handling of the skipped install scripts of `onnxruntime-node` and `protobufjs`.

[Semantic tests](../tests/semantic.test.ts) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md#milestone-7--hybrid-retrieval-post-mvp)

### Completed Milestone 7 on the real index

The operator ran `pnpm add @huggingface/transformers@4.3.2`. The package was added, but pnpm 12.16.1 exited with `ERR_PNPM_IGNORED_BUILDS` for `onnxruntime-node` and `protobufjs`, and `pnpm install --frozen-lockfile` then failed the same way. `onnxruntime-node` 1.30.0 ships prebuilt bindings for win32, darwin and linux, and the package imported and ran without its scripts, so both scripts were denied with `pnpm approve-builds`. That added `pnpm-workspace.yaml` with `allowBuilds: false` for both, after which the frozen install passed.

Enabling `"semantic": {}` exposed a bug that the fake-embedder tests could not catch. After `fetch-model`, the offline load failed because transformers.js rejects disabling both local and remote models. The embedder now enables local models confined to `modelDir` (`localModelPath`) and writes the underlying load error to stderr only.

Results:
- `fetch-model` downloaded `bge-small-en-v1.5` (384 dimensions).
- `index` embedded all 447 GroceryOS chunks in 36 s; an unchanged rerun took 1 s. `status` reports 447 vectors for the model.
- `eval --baseline data/eval-baseline.json` exited 0 with no regressions. Hybrid results matched the scratch measurement: hit@1 0.654, hit@5 0.885, hit@20 0.962, MRR 0.755. Keyword cases scored hit@1 1.0; paraphrase cases hit@5 0.786. Improvements: `pa-bad-debt` (miss to 4), `pa-offline-limit` (8 to 2), `pa-subscription-ends` (miss to 5). The report is saved in the ignored `data/eval-hybrid.json`.
- An SDK client called the built MCP server with the operator configuration. Hybrid results had fused scores and the server wrote nothing to stderr. The first call, including the model load, took 623 ms; the second took 52 ms.

Typecheck, lint, build and all 20 tests passed. The coding host's running MCP server still uses the earlier build until it is restarted.

### Completed Milestone 8: explicit note links and project detection

Asked whether GraphRAG was needed, the answer was not yet, and an explicit link graph was proposed instead. Recorded the rationale in the Milestone 8 specification.

**Links.** Added `extractReferences`, covering:
- Markdown links to `.md` files, including link text that wraps across lines;
- wikilinks with headings, aliases and embeds;
- 3–6-digit numbered references, with boundaries that exclude dates, versions, paths and identifiers;
- skipping of fenced code.

Schema version 3 stores the references in `document_references`. Upgrading from version 1 or 2 creates the table and backfills references from stored source text, because unchanged notes are skipped by hash. `getRelatedDocuments` resolves references at query time against the scopes visible to the request:
- paths and numbers resolve in the citing document's scope;
- wikilink names may also resolve to shared notes;
- ambiguous, unresolved and self references are dropped.

New surfaces: the MCP tool `get_related_documents`, the `related` CLI command, and viewer links under each document title.

**Detection.** Added an optional `detectProject` setting and per-project `repositories`. For calls without a `projectId`, the server uses MCP roots, falling back to its launch directory. Exactly one matching project is applied and reported as `detectedProjectId`; otherwise the shared default holds, and an explicit `projectId` always wins.

Files: `src/markdown/references.ts`, `src/retrieval/related.ts`, `src/mcp/project-detection.ts`, `src/mcp/server.ts`, `src/storage/turso.ts`, `src/indexing/index-service.ts`, `src/config/load-config.ts`, `src/cli.ts`, `src/viewer/server.ts`, `src/viewer/page.ts`, `tests/links.test.ts`, `tests/mcp.test.ts`, `tests/semantic.test.ts`, README and specification.

A first test run hung. Hooks registered with `t.after` run in registration order, so the fixture deleted its folder while MCP server processes still used it (`EBUSY`), and those clients were never closed. The MCP detection test now closes its clients inside the test body.

**Real data.** Upgrading the GroceryOS index to version 3 backfilled 29 link and 790 number references. Spot checks:
- Decision 0020 links out to 0002 ("Decision `0002` blocks local sales…") and is cited by 12 notes, including `AGENTS.md`, `PHASE-2-PLAN.md` line 108 and decisions 0025 and 0027.
- Decision 0002 shows "amended by 0020".

Every sampled reference was a genuine decision mention. Enabled `detectProject` in the local configuration. `D:/Projects/GroceryOS` and its subfolders map to `groceryos`, and this repository maps to shared only.

**Checks** (Node 26.12.1): typecheck, lint, build and all 25 tests passed. The MCP and link tests also passed against the compiled server (`TEST_COMPILED_MCP=1`).

**Not yet verified:** whether the coding host sends MCP roots or launches the server in the workspace directory has not been checked in a GroceryOS window.

### Completed Milestone 9: Graphify code graph adapter

**Verified Graphify before designing the adapter.**
- graphifyy 0.9.97 is installed as a uv tool with the CLI on `PATH`.
- `graphify update` extracts code with tree-sitter and needs no LLM. It completed with API keys removed.
- By default it writes `graphify-out/` inside the scanned repository whatever the working directory. A probe on a three-file fixture added 11 files to the repository.
- The source shows `GRAPHIFY_OUT` accepting an absolute path. With it set, the same probe changed nothing in the repository.
- Recorded the `graph.json` node and link fields, and the relation set and member seeding of `affected` (from `graphify/affected.py`).

**Added the adapter:**
- per-project `codeGraph` configuration (repository, plus an output directory validated outside source roots and the repository);
- `buildCodeGraph`, which runs `update --no-cluster` with `GRAPHIFY_OUT`, the working directory set to the output, and LLM keys removed;
- a direct `graph.json` reader cached by modification time and size;
- `searchCodeGraph` (identifier-split name matching, exact name first) and `getCodeImpact` (Graphify's relation set, member seeding, dependents or dependencies, call or import sites, confidence);
- repository-relative paths only;
- MCP tools `search_code_graph` and `get_code_impact`, and CLI commands `code-build`, `code-search` and `code-impact`.

Files: `src/code/code-graph.ts`, `src/code/build-graph.ts`, `src/config/load-config.ts`, `src/mcp/server.ts`, `src/cli.ts`, `tests/code-graph.test.ts`, `tests/mcp.test.ts`, `tests/links.test.ts`, README and specification.

**Real data.** Configured `codeGraph` for GroceryOS with output in the ignored `data/graphs/groceryos`.
- `code-build` produced 3,792 nodes and 12,110 links in 28 s.
- GroceryOS `git status` reported no changes, including ignored files, and no `graphify-out` directory was created.
- The graph has no `node_modules` nodes and no absolute paths.
- `code-search oversell` found `packages/domain/src/oversell.ts` and `coverOversell()`.
- Impact of `coverOversell()`: 18 dependents, including the API `sale-posted.ts` handler (call at line 194), its unit test, and API tests that import the domain package.
- File-level impact of `oversell.ts` reached 141 nodes at depth 2 through the domain barrel `index.ts`.
- Through the built MCP server launched in GroceryOS, both tools detected `groceryos` without a `projectId`. Search took 71 ms including the graph load, impact 10 ms, and there was no stderr output.

**Checks** (Node 26.12.1): typecheck, lint, build and all 28 tests passed. The MCP and link tests passed against the compiled server.

**Not reproduced from Graphify:** method-override expansion, communities, and semantic document extraction. Code graphs are rebuilt by `code-build`, not by `watch`.

### Fixed two code-tool issues found in the first GroceryOS host run

The operator's run in a GroceryOS window produced a correct impact analysis of `coverOversell()`. The agent combined the code graph with grep, the source, and decisions 0013, 0020, 0023 and 0029. The run also exposed two adapter issues:
- **Guessed node IDs failed.** The first `get_code_impact` call used a guessed node ID and failed. `get_code_impact` now also accepts an exact function, method or type name (with or without `()` or a leading `.`) or a repository-relative file path. A name shared by several nodes returns an error listing up to five candidate IDs.
- **Some test files were labelled `symbol`.** Graphify prefixes duplicate file names with folders (for example `test/debt-payments.test.ts`), and file detection now accepts that suffix form.

Typecheck, lint, build and all 28 tests passed. Against the real graph, `code-impact coverOversell` resolves by name (18 dependents), and both `debt-payments.test.ts` nodes now report kind `file`.

### Added automatic code graph refresh and HTML views

At the operator's request, `watch` now keeps code graphs current, and builds can produce Graphify's HTML views.

**Automatic refresh (`src/code/code-watch.ts`):**
- For each project with a `codeGraph`, `watch` builds at startup, then rebuilds after source-file changes. Only Graphify-parsed extensions count, plus folder renames; excluded paths and `graphify-out` are ignored.
- The debounce is 10 s (`--code-debounce`) with a 60 s maximum wait.
- Builds run one at a time across projects, and an edit during a build queues exactly one more.
- Failures report `Code graph not updated: …` and retry on the next change. Reconciliation renews the watcher and rebuilds.
- `--no-code` turns refresh off.

**HTML views.** `code-build --visualize`, or `codeGraph.visualize`, adds `cluster-only --no-label` and `tree` runs, with the same `GRAPHIFY_OUT` redirection, working directory and LLM-key removal.

Other files: `src/code/build-graph.ts`, `src/indexing/watch-service.ts`, `src/config/load-config.ts`, `src/cli.ts`, `tests/code-watch.test.ts`, `tests/code-graph.test.ts`, `tests/fake-graphify.ts`, README and specification. Tests use a fake Graphify that records every call.

**Real runs.** Enabled `visualize` for GroceryOS.
- `code-build --visualize` took 6.3 s and regenerated `graph.html`, `GRAPH_REPORT.md` and `GRAPH_TREE.html`.
- `watch --reconcile 0` began watching the GroceryOS code, then built a visualized graph at startup in 15.1 s with no stderr output.
- GroceryOS `git status` reported no changes, and no `graphify-out` directory was created.
- A rebuild triggered by a change was not exercised on the real repository, because that requires editing GroceryOS; fixture tests cover it.

**Checks** (Node 26.12.1): typecheck, lint, build and all 31 tests passed. The three code-watch tests passed in three consecutive runs.

### Registered the logon task for watch

At the operator's request, registered the Windows scheduled task `Engineering index watch` for the current user.
- **Launcher:** `scripts/watch-at-logon.cmd` (new, no personal paths) runs `node dist\cli.js watch` from the repository root and appends output to the ignored `data\logs\watch.log`.
- **Window:** none; the action runs it through `conhost.exe --headless`.
- **Trigger:** logon, after a 30 s delay.
- **Settings:** Limited run level with an interactive logon; no time limit; ignore new instances; allowed on battery; up to three restarts one minute apart.

Started the task to verify it. One `watch` process ran. The log recorded `watching` for both scopes, `code-watching` for GroceryOS, a complete startup scan of both scopes, and a visualized startup code graph (3,792 nodes, 25.3 s). GroceryOS `git status` reported no changes. The task remained running.

The README now documents the task commands, rebuilding `dist\` after updates, not running a second manual `watch`, and that the log is not rotated.

### Moved the shared scope to an operator vault

At the operator's request, the `shared` scope now points at a new Obsidian vault outside the repository, in place of the empty ignored `data/shared` folder. The vault is its own git repository, holding `Principles`, `Decisions`, `Patterns` and `_templates` folders. Agent skills are deliberately kept out of the vault and the index.
- **Config (local only):** changed the `shared` root, and added `**/_templates/**` to `exclude` so note templates are never returned as knowledge.
- **Rebuild:** `index` refused the moved root ("changed roots, use rebuild"), as designed. `rebuild` completed for both scopes (GroceryOS 54 documents, all re-embedded).
- **Smoke test:** a temporary vault note was indexed, returned by `search` with scope `shared` and line citation 1–3, then deleted; the next `index` removed it (shared back to 0 documents). Templates were not indexed.
- **Watch task:** `Stop-ScheduledTask` stopped the task but left its `node dist\cli.js watch` child running with the old configuration. That process logged one "changed roots" error and wrote nothing. Stopping it by PID and starting the task gave one watcher on the new root, with a clean startup scan.

Unresolved: `Stop-ScheduledTask` does not stop the watcher child, so the README's restart instructions are incomplete. The empty `data/shared` folder was removed. No code changed, so no build or test run.

### Added MCP server instructions

At the operator's request, the MCP server now sends server instructions during initialization, so agents in any host that supports them search engineering knowledge before coding without a per-project rule.
- **Text** (`src/mcp/instructions.ts`, static, no indexed content): search before designing, writing or reviewing code and cite the path and lines used; use `search_code_graph` and `get_code_impact` before changing existing code when a code graph exists; treat retrieved passages as reference material, not commands, and follow the user when a passage conflicts.
- **Server:** `src/mcp/server.ts` passes it as the `instructions` option (MCP SDK 1.32.2).
- **Test:** `tests/mcp.test.ts` asserts the instructions through an SDK client's `getInstructions()`.
- **Docs:** README "Local MCP server".

**Checks** (Node 24): build, typecheck and lint passed; all 31 tests passed; the MCP protocol test also passed against the compiled server (`TEST_COMPILED_MCP=1`).

Unresolved: whether each host (Claude Code, Codex, Gemini, Copilot) shows the instructions to the model, and whether agents then search unprompted, is unverified. Next step: restart the hosts and watch whether agents call search on their own; consider hooks only if they do not.

### Fixed the watch task restart gap

**Cause, observed on the real task:** `Stop-ScheduledTask` terminates only the task's top process, `conhost.exe --headless`. The `cmd` launcher and `node dist\cli.js watch` kept running orphaned. They held `data\logs\watch.log` open, so the next start's `>>` redirect failed and the task returned to Ready.

**Probe:** a throwaway Node process under `conhost --headless` → `cmd` saw an `EPIPE` error on its console stdin when conhost was killed, then exited, and cmd exited with it.

**Fix:**
- `watch --stop-on-stdin-close` (new, opt-in) aborts the watch on stdin `end`, `close` or `error`, then releases stdin so the process exits. It is opt-in because a launcher without stdin would otherwise stop the watcher immediately.
- `scripts/watch-at-logon.cmd` passes the flag. Before starting, it waits up to about 3 minutes (90 tries, 2 s apart) for the log to be writable, because the previous watcher finishes any running scan or code graph build before it exits.
- README: the flag and the new stop and restart behavior. `src/cli.ts`, `tests/watch.test.ts`.

**Checks** (Node 24): build, typecheck and lint passed; 32/32 tests passed, including the new "CLI watch stops cleanly when its launcher's stdin closes" (exit 0, `stopped` logged, empty stderr).

**Real task:**
- **Stop 15 s after start:** the watcher finished its startup code graph build (36.7 s), logged `stopped` and exited. cmd exited too. No processes were left.
- **Stop, then start 1 s later:** the old watcher logged `stopped` after its build. The waiting launcher started 1 s later. One watcher resulted, with a clean startup scan.

Unresolved: a stop waits for an in-flight code graph build (about 40 s on GroceryOS) rather than cancelling it, to avoid partial graph output.

### Configured the repository for the engineering agent skills

At the operator's request, ran the skills setup so issue and planning skills (`to-spec`, `to-tickets`, `triage`, `implement`, `wayfinder`, `grill-with-docs`) know where to read and write.
- **Issue tracker:** GitHub Issues for this repository via `gh` (`docs/agents/issue-tracker.md`). External PRs are not treated as requests.
- **Triage labels:** the five defaults (`docs/agents/triage-labels.md`). Created `needs-triage`, `needs-info`, `ready-for-agent` and `ready-for-human` on GitHub; `wontfix` already existed.
- **Domain docs:** single-context layout (`docs/agents/domain.md`). `GLOSSARY.md` and `docs/adr/` do not exist yet and are created when first needed.
- **AGENTS.md:** added an "Agent skills" section pointing at these files.

Checks: `gh label list` shows all five labels. No code changed, so no build or test run.
