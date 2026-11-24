# Handoff: architecture deepening (2026-11-24)

A snapshot for the next agent. `docs/STATUS.md` remains the authoritative current state; update or delete this file once its open questions are settled.

Repository: GitHub `ranniemp161/Engineering-Rag`. Read `AGENTS.md`, `docs/STATUS.md`, the latest `docs/PROGRESS.md` entries, `GLOSSARY.md`, and `docs/agents/*.md` first. The skills setup (GitHub issues, default triage labels, single-context domain docs) is recorded in those files.

## Where things stand

- **Candidate 1 (index session)** is done and merged: PR #3 (merge `1ef89c3`) plus records PR #4 (`946df7c`). After the merge, `pnpm build` ran and the `Engineering index watch` scheduled task was restarted on the new build. All feature branches were deleted; only `main` exists.
- **Candidate 2 (one index refresh operation)** is implemented on local branch **`refresh-index`**. It is **uncommitted and awaiting operator review**. The last question asked was "Should I commit this and open a PR?", and there is no answer yet. Don't commit until the operator says so. The design and results are in the latest `docs/PROGRESS.md` entry ("One index refresh operation…") and in `git diff` on that branch. Checks were green: build, typecheck, lint, 49/49 tests, `TEST_COMPILED_MCP=1 node --test tests/mcp.test.ts`.
- **Open item:** every check ran on Node 26.12.1. AGENTS.md requires Node 24 LTS, which isn't installed. This is recorded in STATUS and PROGRESS; don't claim Node 24 verification.

## Remaining architecture candidates

These come from the 2026-11-24 review; the summary is in `docs/PROGRESS.md` under "Architecture review: deepening candidates". The HTML report was a temporary file outside the repository, so treat PROGRESS as the source.

- 3: one retrieval module behind MCP, the viewer and the CLI (error policy, project resolution, the 64 KiB budget). Candidate 1 partly addressed the error policy.
- 4: a single search pipeline (hybrid fallback opens a second session; the result-shaping loop is duplicated).
- 5: a shared debounced root watcher for notes and code watch.
- 6: a resolved config type (speculative).
- Review notes that were not chosen are listed under "Second review fixes" in PROGRESS: the `IndexError`/`knownScopes` naming, `config` passed twice, the `hasEmbeddings` alias, the multi-step viewer test, and the schema-downgrade fixture.

## How this operator works (observed this session)

- Flow per candidate:
  1. `/improve-codebase-architecture`, then grilling in rounds (numbered questions, each with a recommended answer; the operator usually replies "yes to all").
  2. TDD on a branch, then full checks, then update PROGRESS/STATUS/GLOSSARY.
  3. **Stop for review before committing.**
  4. On request: commit, push, and open a PR using the `pr` skill template (Summary / Evidence / Merge Danger).
  5. `/code-review main` (two parallel sub-agents, standards plus spec), then fix the chosen findings on the same branch.
  6. Merge with `gh pr merge N --merge --match-head-commit <sha>`.
  7. Pull `main`, run `pnpm build`, restart the watch task, and update STATUS via a small docs PR.
- For the spec axis of `/code-review` there's no issue tracker spec. Write the agreed grilling decisions (Q1…Qn plus follow-ups) to a scratch file and pass it to the spec sub-agent.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with the Claude Code line.
- Restarting the watch task: `Stop-ScheduledTask` then `Start-ScheduledTask -TaskName 'Engineering index watch'`. Wait until exactly one `node dist\cli.js watch` process remains and `data\logs\watch.log` shows `stopped`, then `watching` and a clean startup `scan`. See README "Keep the index current automatically". The log contains local machine paths, so don't copy them into repo docs.
- Before designing or reviewing code, the engineering MCP server asks for `search_engineering_knowledge`. The relevant shared principles are `Principles/Error handling.md` (safe messages, expected failures as values) and `Principles/Testing.md` (test through public interfaces). Cite path and lines.

## Suggested skills

- `pr`: if the operator approves committing candidate 2 (PR body template).
- `code-review`: with args `main`, after the PR is open.
- `improve-codebase-architecture`, `grilling`, `codebase-design`, `domain-modeling`: to take on candidates 3–6.
- `tdd`: for implementation.
- `writing-for-agents`: only if AGENTS.md or skills need editing.
