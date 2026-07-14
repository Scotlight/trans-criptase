---
name: trans
description: "Session transcript resume (DNA-style transcription): read a broken/old session's JSONL transcript, extract ORIGINAL TASK → DONE → BREAKPOINT → REMAINING, report, then continue. Use when the user says /trans, resume session, pick up where we left off, continue from last time, yesterday, what did we do, or provides a session UUID."
argument-hint: "[sessionId or prefix] [tail record count, default 60]"
---

# /trans — Session transcript resume

DNA central dogma approach: **transcribe** (read the dead session's JSONL into intelligence) → **translate** (produce a resumption report) → **express** (continue the work). Read-only on transcript files, never modifies them.

> **MCP first**: if this session has the `trans` MCP server connected (tools `trans_scan` / `trans_list` / `trans_search` / `trans_expand` / `trans_index`), call the tools directly and skip the script commands below; they are semantically equivalent, and the tools auto-refresh the index. The scripts below are a fallback when MCP is unavailable.

## 1. Transcribe: run the scan script (one call, full intelligence)

> When MCP is available: `trans_scan({id})` is equivalent; if unsure which session to resume, call `trans_list()` first.

```powershell
& "$env:USERPROFILE\.claude\skills\trans\scripts\scan-transcript.ps1" -Id <ID-prefix>
```

| Param | Purpose |
|---|---|
| `-Id <prefix>` | Session UUID or prefix; searches current project first, then globally |
| (no args) | Auto-picks the **second-newest** transcript in current project (newest = this session, auto-skipped) |
| `-List` | List candidate sessions (mtime desc + first user message preview); use when user didn't provide an ID |
| `-Tail <n>` | Tail overview record count, default 60 |
| `-MaxMsgs <n>` | User message thread count, default 60; `0` = all |
| `-Detail <line>` | Override breakpoint detail anchor (default: auto-picks last task-bearing user message, filtering out "Continue from where you left off" / [Request interrupted] / image-only / bare #tags) |
| `-Path <path>` | Specify transcript file directly, skip discovery |
| `-Project <path>` | Resolve for a different project directory (default: cwd) |

Output has five sections: **session file** (size) → **compacted summary** (if present) → **user message thread** (with line numbers + timestamps, reconstructing the task trajectory) → **tail overview** (where it broke) → **breakpoint detail** (all assistant actions after the anchor, including full Edit/Write input — the precise boundary of the half-finished work).

If output is truncated on long sessions: reduce `-MaxMsgs`/`-Tail` for partial runs, or use `-Detail` to zoom into just the breakpoint section.

## 2. Manual fallback (if scripts are missing/broken)

Transcripts live at `~/.claude/projects/<encoded>/*.jsonl`, where encoded = project cwd with **all non-alphanumeric chars replaced by `-`**. Each line is one JSON record: `type` ∈ `user`/`assistant`/`summary`; `message.content` is a string or block array (`text`/`tool_use`/`tool_result`). Extract with `Get-Content -Tail` + `ConvertFrom-Json` layer by layer: tail overview first, then full real user messages (filter `^\s*<` noise and `isSidechain`), then extract assistant tool_use inputs from the last task message onward. **Never read a large file whole into context.**

## 3. Verify: reconcile with disk (mandatory)

**Transcript ≠ disk truth.** Every "completed" edit in the transcript must be verified against what actually landed on disk — another session may have overwritten it:

1. `git status --short` + `git diff --stat` — does the working tree match what the breakpoint detail claims?
2. For each Edit/Write in the breakpoint detail, verify current state with Read / `git diff <file>`
3. Working tree has changes the transcript can't explain → **stop and report**, handle as multi-session conflict, don't overwrite

## 4. Translate and express: produce the resumption report, then continue

Report in four sections: **ORIGINAL TASK → DONE (verified) → BREAKPOINT (which file, which step) → REMAINING steps**.

Then resume per the target project's rules: if the project has a write gate / approval requirement (typically in its CLAUDE.md), present a plan and wait for confirmation before writing; otherwise continue directly. Reuse the original session's approach and naming — don't start from scratch.

## 5. Semantic search: fuzzy-recall old details across sessions (optional enhancement)

Scenario: user mentions an old detail not in the current context — "how did we do the font migration last time", "that WebDAV CORS issue we discussed before" — but can't remember which session. Use vector search for fuzzy recall, get `sessionId:line`, then expand.

> When MCP is available: `trans_search({query})` → on hit `trans_expand({sessionId, line})`; the index auto-refreshes before search, zero maintenance. CLI commands below are fallback.

**One-time setup**: edit `~/.claude/skills/trans/embed-config.json` with `baseUrl` (OpenAI-compatible, ending in `/v1`) and `apiKey`; or set env vars `TRANS_EMBED_BASE_URL` / `TRANS_EMBED_API_KEY` (recommended — keeps the key out of files). Default model: `BAAI/bge-m3` (best for Chinese retrieval); reranker default: `BAAI/bge-reranker-v2-m3`.

```powershell
# Build/update index for current project (incremental: only new lines, unchanged sessions skipped)
node "$env:USERPROFILE\.claude\skills\trans\scripts\semantic.mjs" index
node ...\semantic.mjs index --no-embed # keyword-only index, zero API cost (queries must use --exact)
node ...\semantic.mjs index --dry      # estimate new chunk count without calling API
node ...\semantic.mjs index --all      # index all projects
node ...\semantic.mjs index --force    # full rebuild (after model change or index corruption)

# Query: outputs score / sessionId:line / role+time / preview. Default: hybrid (vector + keyword RRF fusion)
node ...\semantic.mjs query "font migration to dedicated table" --top 8
node ...\semantic.mjs query "..." --exact       # keyword/substring only (variable names, error strings; no API)
node ...\semantic.mjs query "..." --semantic    # vector only (conceptual fuzzy query)
node ...\semantic.mjs query "..." --rerank      # rerank after recall for highest quality
node ...\semantic.mjs query "..." --all         # search across all projects

node ...\semantic.mjs status           # index stats per project: model/dims/chunks/size
```

After a hit: `scan-transcript.ps1 -Id <session-prefix> -Detail <line>` to expand that section's full context.

Key facts: vector binary is stored at `~/.claude/skills/trans/index/<project-encoded>/`, no database dependency; incremental indexing tracks per-session processed lines via `state.json`; switching embedding models triggers auto-rebuild (dimension-mismatched queries are skipped with a warning).
