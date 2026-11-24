# Project status

Updated 2026-11-24. **The MVP (Milestones 0–4) is complete. Post-MVP Milestones 5 (automatic refresh) and 6 (retrieval evaluation) are complete and awaiting review. Milestone 7 (hybrid retrieval) is complete. Milestone 8 (explicit note links and project detection) is complete. Milestone 9 (Graphify code graph adapter) is complete and awaiting review. All future extensions in the specification except packaging and remote transport are now delivered.**

Branch `index-session`, open as PR #3 and awaiting review: every index access now goes through one index session module (`src/storage/index-session.ts`), which owns the guard, schema upgrade, capabilities and scope root checks. Read-only opens of a missing index create nothing, and the viewer no longer returns raw error messages. 42/42 tests pass on Node 26.12.1. Open: the locking and native FTS checks have not been rerun on Node 24 LTS, which is not installed on this machine. Next action: the operator installs Node 24 and reruns the checks, reviews and merges the PR, then runs `pnpm build` and restarts the watch task. [Progress](PROGRESS.md) · [Glossary](../GLOSSARY.md)

The MCP server now sends instructions on connect asking agents to search engineering knowledge before coding. Next action: restart the coding hosts and check whether agents search unprompted. [Server instructions](../README.md#local-mcp-server)

The `shared` scope now points at an operator Obsidian vault outside the repository, with templates excluded from indexing. It is empty until the operator writes notes. Stopping the logon task now stops the watcher too, after any in-progress scan or code graph build, and an immediate restart waits for it. [Progress](PROGRESS.md)

`get_related_documents` lists the notes a document links to and the notes that link to it, from explicit links, wikilinks and decision numbers (index schema version 3). With `detectProject` enabled, MCP calls without `projectId` use the workspace's project. [Links and detection](../README.md#automatic-project-detection)

`search_code_graph` and `get_code_impact` answer code questions from a Graphify graph built by `code-build` outside the repository. GroceryOS: 3,792 nodes, built in 28 s, with the repository unchanged. `watch` now rebuilds code graphs about 10 s after source edits, and `visualize` keeps `graph.html` and `GRAPH_TREE.html` current in `data/graphs/groceryos`. On this machine, the scheduled task `Engineering index watch` starts `watch` at logon and logs to `data/logs/watch.log`. Run `pnpm build` and restart the task after code updates. Next action: the operator restarts the coding host and confirms detection and the code tools from a window opened on GroceryOS, then reruns `code-build` after code changes. Remaining specification extensions are packaging (7) and remote MCP transport (8), both conditional on need. [Code graph](../README.md#code-graph-graphify)

Hybrid retrieval is enabled for the local GroceryOS pilot: `bge-small-en-v1.5`, all 447 chunks embedded. Against the keyword baseline, overall hit@5 rose from 0.769 to 0.885 and MRR from 0.588 to 0.755, with no regressions. Two paraphrase cases remain weak (decision 0004 at rank 10, decision 0015 at rank 13), and `pa-tingi` dropped out of the top 20. [Hybrid retrieval](../README.md#hybrid-retrieval-optional) · [Progress](PROGRESS.md)

`pnpm dev -- eval` scores search against operator-local cases and compares the result with a saved baseline. The local GroceryOS baseline shows hit@5 of 1.0 for keyword queries but 0.571 for paraphrased ones, and 4 of 14 paraphrases found nothing. This is the evidence the specification requires before hybrid retrieval. Next action: the operator reviews Milestones 5 and 6 and chooses the next milestone. Hybrid retrieval, measured against this baseline, is the natural candidate; automatic project detection and the Graphify adapter remain options. [Evaluation usage](../README.md#measure-retrieval-quality)

The CLI can validate configuration, index and rebuild Markdown, report status, and search for ranked passages with source citations. Project isolation and citations were verified on Windows x64 with Node 24.22.3 and embedded Turso 0.8.4. Warm guarded retrieval measured 33.3 ms p95 on a synthetic 10,000-chunk corpus. Other platforms and a real vault remain unverified. [CLI instructions](../README.md) · [Search acceptance test](../tests/search.test.ts)

The local MCP stdio server now exposes ranked search and bounded document reads. An official SDK client verified discovery, invocation, source citations, scope isolation and clean protocol output for the source and compiled entry points. [Server](../src/mcp/server.ts) · [Protocol test](../tests/mcp.test.ts)

`pnpm dev -- watch` keeps the index current while it runs and recovers from busy indexes and from missing or replaced roots. It reran the GroceryOS scope cleanly. [Watch usage](../README.md#keep-the-index-current-automatically) · [Watch tests](../tests/watch.test.ts)

`pnpm viewer` opens a read-only localhost page for browsing indexed documents, running scoped searches and reading cited lines. It has no automated test yet. [Viewer usage](../README.md#browse-the-index)

## Host verification and optional pilot

Codex CLI 0.171.0 launched the compiled server, searched a synthetic project, read the returned document ID, and cited the correct path and lines for two engineering decisions. [Verified host setup](CODEX_HOST.md)

The first real repository pilot is active locally under `groceryos`. Its initial scan indexed 53 Markdown documents into 447 chunks with zero errors. The Codex extension in VS Code used both Engineering tools to answer a question about offline oversells. The cited lines matched Decision 0020. Rerun the index command after editing the notes. [Progress history](PROGRESS.md) · [Specification](../ENGINEERING_INTELLIGENCE_SPEC.md)
