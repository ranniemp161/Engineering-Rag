# Run the local index with Codex CLI

Verified on Windows x64 with Codex CLI 0.171.0 and Node 24.22.3. Codex launches the compiled server as a stdio child process. The server opens the configured local index for each tool call.

## Prepare the index

From the engine checkout, run `pnpm install --frozen-lockfile` and `pnpm build`. Copy `config.example.json` to a private local configuration file. Set the shared and project roots to approved Markdown directories and keep the database outside them. A temporary directory of Markdown notes works for this walkthrough. The Obsidian application can be closed or absent.

```powershell
$env:ENGINEERING_INTELLIGENCE_CONFIG = 'C:/example/engineering/config.local.json'
node dist/cli.js index
node dist/cli.js status
```

## Configure the coding host

Use the following entry in your Codex `config.toml` for persistent use. Replace the example paths with the absolute paths to Node 24, the built server, and the same configuration file used for indexing. The server launch command is `node dist/mcp/server.js` from the checkout. Using absolute paths lets the coding host start it from another project.

```toml
[mcp_servers.engineering]
command = 'C:/example/node24/node.exe'
args = ['C:/example/engineering/dist/mcp/server.js']

[mcp_servers.engineering.env]
ENGINEERING_INTELLIGENCE_CONFIG = 'C:/example/engineering/config.local.json'
```

The acceptance run supplied these three settings as per-invocation `-c` overrides to `codex exec --ephemeral --ignore-user-config --skip-git-repo-check -s read-only --json`. It ran from an empty task directory and left the user's persistent host configuration untouched. [Official Codex MCP configuration](https://developers.openai.com/codex/mcp)

## Repeat the citation check

1. Configure an empty shared folder and a project folder with ID `pilot`. In the project folder, create `decisions/offline-retries.md` with the four lines below, including the blank second line.
2. Run the index command above. Start Codex with the server configured and ask: “Use the engineering MCP tools to search project pilot for offline inventory retries. Read the matching document, then explain what to do before delivery and how long to wait after failure. Cite the relative path and the supporting lines.”
3. Check the host's tool activity. Search should return the project document ID. The subsequent document read should use that ID and the same project scope.

```markdown
# Offline retry decision

Queue the inventory adjustment locally before attempting delivery.
After a failed delivery, wait 47 seconds before the next attempt.
```

In the verified run, Codex completed both tool calls and cited `decisions/offline-retries.md` line 3 for local queuing and line 4 for the 47-second delay. The prompt omitted the path, delay, and line numbers. This check verifies an explicitly requested retrieval. Host decisions about when to search on other tasks can vary.

Indexing and MCP retrieval run locally. A connected coding host can send the passages it retrieves to its model provider. For a real Obsidian pilot, select a small folder of notes approved for that host, then rerun `index` whenever those notes change.
