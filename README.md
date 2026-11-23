# Engineering Intelligence Engine

A local TypeScript project for retrieving cited passages from approved Markdown folders. See the [current status](docs/STATUS.md) for what runs today and the [progress history](docs/PROGRESS.md) for completed work and verification.

## Setup

Use Node.js 24 LTS (verified with 24.22.3) and pnpm 12.16.1. From the project directory, run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

The tests create temporary synthetic Markdown folders and remove them after each case. A real Obsidian vault is optional for this milestone.

## Validate an operator configuration

Copy `config.example.json` to `config.local.json`. Replace the placeholder roots with existing, approved local directories. Keep the `shared` scope and add named project scopes as needed. Use separate, non-overlapping directories so that project notes cannot also enter the shared scope.

```sh
pnpm config:check
```

After a build, `node dist/check-config.js` runs the same check. An invalid configuration prints a diagnostic to stderr and exits with code 1. Set `ENGINEERING_INTELLIGENCE_CONFIG` to use another configuration file. Paths inside the file resolve relative to its directory. The database path may point into a future directory outside all source roots. Validation reads configuration and directory metadata only.

Omitting `exclude` selects the defaults shown in the example. Providing an array replaces those defaults. Omitted search limits default to 5 results with a maximum of 20.

## Maintain the local index

```sh
pnpm dev -- index
pnpm dev -- status
pnpm dev -- rebuild
```

After building, use `node dist/cli.js` with the same command. Each command prints JSON on success. `index` creates schema version 1 as needed, reads approved Markdown, and commits changes per scope. An unchanged hash skips chunk replacement. Directory links and linked files are skipped. If a directory is unavailable, the scan records an error and preserves stale entries in that scope. Partial scans exit with code 1 and include per-scope results.

`status` reports document and chunk counts, the last successful scan, the latest run, and up to 20 of its errors per indexed scope. Before the first index it reports `initialized: false`. `rebuild` replaces the indexed content and scan history in one transaction. A failed scan rolls the replacement back. Use rebuild after moving a configured scope to a new root or to discard a removed scope's stored data.

The local database directory must be writable for the persistent sibling guard file. Concurrent commands wait up to one second to acquire the guard, then report `INDEX_BUSY` so the caller can retry.

## Keep the index current automatically

```sh
pnpm dev -- watch
pnpm dev -- watch --debounce 2000 --reconcile 30
```

`watch` performs a startup scan of every scope, then rescans a scope about one second after its Markdown changes stop. It ignores excluded paths and files other than Markdown, so code edits in a project repository do not trigger rescans. Continuous changes are rescanned at least every 10 seconds. Each rescan is the same transactional scan as `index`, and the guard is held only while it runs, so the MCP server and viewer keep working. A busy index is retried, and a root that is missing or replaced is reattached without a restart. Every `--reconcile` minutes (default 15, `0` disables) it rescans all scopes to cover missed filesystem events. `--debounce` sets the quiet period in milliseconds (default 1000).

Each event is printed as one JSON line on stdout (`watching`, `scan`, `busy`, `watch-error`, `error`, `stopped`). Stop with Ctrl+C. Restart `watch` after editing the configuration. After a build, `node dist/cli.js watch` accepts the same flags.

To run it at logon on Windows, create a scheduled task that runs the built command. Replace the example paths:

```powershell
$action = New-ScheduledTaskAction -Execute 'C:/example/node24/node.exe' -Argument 'C:/example/engineering/dist/cli.js watch' -WorkingDirectory 'C:/example/engineering'
Register-ScheduledTask -TaskName 'Engineering index watch' -Action $action -Trigger (New-ScheduledTaskTrigger -AtLogOn) -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0)
```

## Search indexed notes

```sh
pnpm dev -- search "offline inventory"
pnpm dev -- search "offline inventory" --project example-project --limit 3 --json
```

Use a configured project ID. Omitting `--project` searches shared notes only. Supplying it includes that project and shared notes. The search reads the most recent indexed content. Run `index` after changing notes.

Search accepts up to 512 UTF-16 code units. It treats Unicode words and numbers as literal keywords, splits at punctuation, and matches any of the terms. Turso ranks the matching passages. Ties use the stable document ID and chunk ordinal. Results include verbatim snippets from the indexed text with normalized line endings, relative paths, and one-based inclusive line ranges.

Output is JSON by default, including when `--json` is supplied. An empty `results` array means the search succeeded with no eligible matches. Invalid input and missing indexes produce diagnostics on stderr with exit code 1. After building, `node dist/cli.js search` accepts the same arguments.

## Measure retrieval quality

```sh
pnpm dev -- eval
pnpm dev -- eval --output data/eval-baseline.json
pnpm dev -- eval --baseline data/eval-baseline.json
```

`eval` runs a set of known questions through the same search service the MCP tool uses and reports where the expected notes rank. Copy [evaluation.example.json](evaluation.example.json) to `evaluation.local.json` (ignored by Git) or pass `--file`; `ENGINEERING_INTELLIGENCE_EVAL` also sets the default. Each case has a unique `id`, a `query`, an optional `projectId`, and one or more `expect` entries. An entry names a `path` relative to its scope, an optional `scope` (defaulting to the case's project, otherwise `shared`), and optional inclusive `lines`, which a cited passage must overlap. Optional `tags` group the results, for example `keyword` for queries that use a note's own words and `paraphrase` for the same question in other words. Cases that expect a scope their search cannot reach are rejected.

The JSON report includes hit@1, hit@3, hit@5 and hit@20 (the configured maximum limit), mean reciprocal rank, recall@5 and latency percentiles. It gives these overall, per tag and per project, along with each case's rank and top three results. `--output` saves the report. `--baseline` compares the run with a saved report and lists metric deltas, added and removed cases, improvements and regressions. A regression is a case that was in the top 5 and no longer is, and any regression makes the command exit with code 1. Update the baseline deliberately after an accepted change.

Record real misses as cases when an agent or search fails to find a note you know exists. These cases are the evidence the specification requires before adding semantic retrieval.

## Hybrid retrieval (optional)

Keyword search misses questions phrased in other words. Hybrid retrieval adds a local embedding model and merges its ranking with the keyword ranking. It is off unless the configuration has a `semantic` section:

```json
"semantic": {
  "model": "Xenova/bge-small-en-v1.5",
  "modelDir": "./data/models",
  "keywordWeight": 1,
  "semanticWeight": 1
}
```

Every field is optional; the values shown are the defaults. `modelDir` resolves relative to the configuration file and must lie outside source roots. `queryPrefix` and `passagePrefix` override the retrieval prefixes. Known prefixes are built in for `bge-small-en-v1.5`, `bge-base-en-v1.5`, `multilingual-e5-small` and `all-MiniLM-L6-v2`.

The embedding runtime, `@huggingface/transformers`, is a regular dependency. [pnpm-workspace.yaml](pnpm-workspace.yaml) denies the install scripts of `onnxruntime-node` and `protobufjs`, so a frozen install succeeds without running them. `onnxruntime-node` ships prebuilt binaries for Windows, macOS and Linux. After adding the section, download the model once (this needs network access) and index:

```sh
pnpm dev -- fetch-model
pnpm dev -- index
```

`fetch-model` downloads the configured model, about 33 MB for the default, into `modelDir`. No other command downloads; they all run offline. `index`, `rebuild` and `watch` then embed every passage that has no vector for the configured model. Unchanged notes are not embedded again, and changing `model` replaces all vectors on the next run. The first run embeds the whole index, which took about 40 seconds for 447 passages here. The guard is held during that run, so MCP calls report `INDEX_BUSY` until it finishes. If the package or model is missing, keyword indexing still completes, and the command reports the problem and exits with code 1.

With `semantic` configured, `search`, the MCP tool, the viewer and `eval` run in hybrid mode. Each takes the top 50 keyword passages and the top 50 by exact cosine similarity within the allowed scopes, then merges them with weighted Reciprocal Rank Fusion (`weight / (60 + rank)`). In this mode `score` is the fused score. Without embeddings, a default search falls back to keywords and logs a diagnostic to stderr. `--mode keyword` or `--mode hybrid` on `search` and `eval` forces a mode, and a forced hybrid search fails instead of falling back. `status` lists vectors per model for each scope.

An MCP server process loads the model on its first hybrid search, about 0.6 s on the test machine, and later searches took about 50 ms. Restart the MCP host after enabling `semantic` or rebuilding.

Measured on 26 GroceryOS cases, against the keyword baseline (hit@5 0.769, MRR 0.588):

- `bge-small-en-v1.5` at the default weights raised hit@5 to 0.885 and MRR to 0.755. All keyword cases ranked first, and paraphrase hit@5 rose from 0.571 to 0.786.
- `"semanticWeight": 2` raised MRR to 0.785.

Compare settings with `eval --mode keyword` and `eval --baseline` before changing them.

## Browse the index

```sh
pnpm viewer
pnpm viewer -- --port 4400 --no-open
```

This starts a read-only page at `http://127.0.0.1:4317` and opens it in the default browser. The page lists indexed documents per scope with counts and the last scan time. It also runs scoped searches and shows cited documents with line numbers, highlighting the cited lines. **Evaluate** runs the evaluation cases and shows the metrics, per-tag and per-project tables, and each case's rank. Click a case to run its search. `--eval FILE` selects the cases and `--baseline REPORT` adds the comparison. It calls the same search and document services as the MCP server, binds to localhost only, and takes the index guard per request, so indexing can run while it is open. Stop it with Ctrl+C. After a build, `node dist/viewer/server.js` accepts the same flags.

Generic SQLite tools cannot open the database file because they do not recognize Turso's `USING fts` index in the schema. Use the viewer or the CLI instead.

## Local MCP server

Build with `pnpm build`. The stdio launch command from the project root is:

```sh
node dist/mcp/server.js
```

A client running from another directory can launch Node with an absolute path to the compiled server and set `ENGINEERING_INTELLIGENCE_CONFIG` to the absolute configuration file path. The client owns stdin and stdout. Server diagnostics go to stderr. Each tool call reloads the local configuration and opens a fresh guarded read-only index connection.

- `search_engineering_knowledge` accepts `query`, optional `projectId`, and optional `limit`. It returns the same ranked JSON payload as the CLI inside an MCP text content block.
- `get_document` accepts the indexed `documentId` returned by search and the same optional `projectId`. Set `startLine` (default 1) and `maxLines` (default 100, maximum 200). The response includes title, scope, relative path, inclusive line range and indexed source text with LF line endings. `nextStartLine` gives the next line, or null at the end. The text budget is 8,192 UTF-16 code units. If a single line exceeds that budget the server returns its prefix, sets `truncatedLine`, and resumes at the following line. The full JSON payload is capped at 64 KiB.

Run `pnpm test` for an SDK client walkthrough against synthetic notes. The test discovers both tools, uses a returned ID to fetch a passage, and checks scope restrictions. [MCP integration test](tests/mcp.test.ts)

For the verified Codex CLI setup, including a host configuration example and a four-line retrieval exercise, see [Run the local index with Codex CLI](docs/CODEX_HOST.md).

The architecture, tool contracts, Windows locking decision, and milestone acceptance criteria are in the [engineering specification](ENGINEERING_INTELLIGENCE_SPEC.md).
