# Project status

Updated 2026-11-23. **Milestone 3 is complete. Milestone 4 is next.**

The CLI can validate configuration, index and rebuild Markdown, report status, and search for ranked passages with source citations. Project isolation and citations were verified on Windows x64 with Node 24.22.3 and embedded Turso 0.8.4. Warm guarded retrieval measured 33.3 ms p95 on a synthetic 10,000-chunk corpus. Other platforms and a real vault remain unverified. [CLI instructions](../README.md) · [Search acceptance test](../tests/search.test.ts)

The local MCP stdio server now exposes ranked search and bounded document reads. An official SDK client verified discovery, invocation, source citations, scope isolation and clean protocol output for the source and compiled entry points. [Server](../src/mcp/server.ts) · [Protocol test](../tests/mcp.test.ts)

## Next milestone

For Milestone 4, verify the compiled server in one actual coding host, document that host's launch configuration, and demonstrate a task that retrieves and cites a fixture or explicitly approved note.

The actual vault location and first MCP host remain open for later integration. [Progress history](PROGRESS.md) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md)
