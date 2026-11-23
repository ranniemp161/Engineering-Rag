# Project status

Updated 2026-11-24. **The MVP (Milestones 0–4) is complete. Post-MVP Milestone 5 is complete and awaiting review.**

The CLI can validate configuration, index and rebuild Markdown, report status, and search for ranked passages with source citations. Project isolation and citations were verified on Windows x64 with Node 24.22.3 and embedded Turso 0.8.4. Warm guarded retrieval measured 33.3 ms p95 on a synthetic 10,000-chunk corpus. Other platforms and a real vault remain unverified. [CLI instructions](../README.md) · [Search acceptance test](../tests/search.test.ts)

The local MCP stdio server now exposes ranked search and bounded document reads. An official SDK client verified discovery, invocation, source citations, scope isolation and clean protocol output for the source and compiled entry points. [Server](../src/mcp/server.ts) · [Protocol test](../tests/mcp.test.ts)

**Milestone 5 (automatic index refresh) is complete and awaiting review.** `pnpm dev -- watch` keeps the index current while it runs and recovers from busy indexes and from missing or replaced roots. It reran the GroceryOS scope cleanly. Next action: the operator reviews Milestone 5 and chooses the next post-MVP milestone (retrieval evaluation, automatic project detection, hybrid retrieval or the Graphify adapter). [Watch usage](../README.md#keep-the-index-current-automatically) · [Watch tests](../tests/watch.test.ts)

`pnpm viewer` opens a read-only localhost page for browsing indexed documents, running scoped searches and reading cited lines. It has no automated test yet. [Viewer usage](../README.md#browse-the-index)

## Host verification and optional pilot

Codex CLI 0.171.0 launched the compiled server, searched a synthetic project, read the returned document ID, and cited the correct path and lines for two engineering decisions. [Verified host setup](CODEX_HOST.md)

The first real repository pilot is active locally under `groceryos`. Its initial scan indexed 53 Markdown documents into 447 chunks with zero errors. The Codex extension in VS Code used both Engineering tools to answer a question about offline oversells. The cited lines matched Decision 0020. Rerun the index command after editing the notes. [Progress history](PROGRESS.md) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md)
