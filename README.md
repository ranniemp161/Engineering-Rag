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

## Search indexed notes

```sh
pnpm dev -- search "offline inventory"
pnpm dev -- search "offline inventory" --project example-project --limit 3 --json
```

Use a configured project ID. Omitting `--project` searches shared notes only. Supplying it includes that project and shared notes. The search reads the most recent indexed content. Run `index` after changing notes.

Search accepts up to 512 UTF-16 code units. It treats Unicode words and numbers as literal keywords, splits at punctuation, and matches any of the terms. Turso ranks the matching passages. Ties use the stable document ID and chunk ordinal. Results include verbatim snippets from the indexed text with normalized line endings, relative paths, and one-based inclusive line ranges.

Output is JSON by default, including when `--json` is supplied. An empty `results` array means the search succeeded with no eligible matches. Invalid input and missing indexes produce diagnostics on stderr with exit code 1. After building, `node dist/cli.js search` accepts the same arguments.

## Browse the index

```sh
pnpm viewer
pnpm viewer -- --port 4400 --no-open
```

This starts a read-only page at `http://127.0.0.1:4317` and opens it in the default browser. The page lists indexed documents per scope with counts and the last scan time. It also runs scoped searches and shows cited documents with line numbers, highlighting the cited lines. It calls the same search and document services as the MCP server, binds to localhost only, and takes the index guard per request, so indexing can run while it is open. Stop it with Ctrl+C. After a build, `node dist/viewer/server.js` accepts the same flags.

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
