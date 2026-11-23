# Project status

Updated 2026-11-23. **Milestone 4 is complete. The MVP has passed its Windows fixture and coding-host checks.**

The CLI can validate configuration, index and rebuild Markdown, report status, and search for ranked passages with source citations. Project isolation and citations were verified on Windows x64 with Node 24.22.3 and embedded Turso 0.8.4. Warm guarded retrieval measured 33.3 ms p95 on a synthetic 10,000-chunk corpus. Other platforms and a real vault remain unverified. [CLI instructions](../README.md) · [Search acceptance test](../tests/search.test.ts)

The local MCP stdio server now exposes ranked search and bounded document reads. An official SDK client verified discovery, invocation, source citations, scope isolation and clean protocol output for the source and compiled entry points. [Server](../src/mcp/server.ts) · [Protocol test](../tests/mcp.test.ts)

## Host verification and optional pilot

Codex CLI 0.171.0 launched the compiled server, searched a synthetic project, read the returned document ID, and cited the correct path and lines for two engineering decisions. [Verified host setup](CODEX_HOST.md)

The first real repository pilot is active locally under `groceryos`. Its initial scan indexed 53 Markdown documents into 447 chunks with zero errors. The Codex extension in VS Code used both Engineering tools to answer a question about offline oversells. The cited lines matched Decision 0020. Rerun the index command after editing the notes. [Progress history](PROGRESS.md) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md)
