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

The architecture, tool contracts, Windows locking decision, and milestone acceptance criteria are in the [engineering specification](ENGINEERING_INTELLIGENCE_SPEC.md).
