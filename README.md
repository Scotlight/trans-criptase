# transcriptase

**English** | [简体中文](README.zh-CN.md)

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-community-ffb003?logo=discourse&logoColor=white)](https://linux.do)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> Make Claude Code remember what it already said.

Every Claude Code session leaves a full transcript on disk (JSONL), but all you get officially is a flat `--resume` list — you can't find, search, or resume across it. transcriptase turns those dormant transcripts into two things: **a resumable scene**, and **a searchable memory**.

The name comes from reverse transcriptase: others transcribe conversations into files; we reverse-transcribe files back into live context.

## Three capabilities

**1. Session resumption (`/trans`)**
Session dropped, context blew up, machine rebooted? One command scans an old session transcript and produces a five-part resumption brief:

```
session size → compacted summary → user-message thread (with line numbers) → tail overview → breakpoint detail (full content of every Edit/Write)
```

The breakpoint detail pins down "which step of which file you last touched, which edit never landed" — the new session picks up from there instead of re-treading the whole path.

**2. Cross-session semantic search**
"How did I do that font migration last time?" "Which session mentioned the merge collision?" — not in the current context, but it's in the transcripts. Hybrid search (vector + keyword RRF fusion, optional reranker) does fuzzy recall and returns `sessionId:line`.

**3. Line-level context expansion**
After a hit, pull the full records around `sessionId:line` (including tool calls and results) and **re-inject those old details into the current conversation** — instead of jumping off to resume a dead session whose context blew up long ago.

All three are offered simultaneously as **MCP tools + CLI + Claude Code skill**: the model can call them itself (auto-search when you casually mention an old detail), and you can run them by hand.

## Quick start

### Method A: one-command install via marketplace (recommended)

This repo is also a Claude Code plugin **marketplace**. Add it once, then install:

```shell
/plugin marketplace add Scotlight/trans-criptase
/plugin install trans@trans-criptase
```

That is all for the skill + SessionEnd hook (they load with the plugin, **without touching your `settings.json`**). To unlock semantic/hybrid search you still configure embedding once (see [Configuration](#configuration)); the MCP server can be registered with `claude mcp add` (see Method B step 2) or declared via the plugin's `.mcp.json`.

### Method B: clone into the skills directory (for development / customization)

transcriptase is a **Claude Code skills-dir plugin**: clone it under `~/.claude/skills/` and it auto-loads next session (the skill + SessionEnd hook take effect with the plugin, **without touching your `settings.json`**). MCP tools are registered with one `claude mcp add`.

```powershell
# 1. Clone into the skills directory (the folder MUST be named trans)
git clone https://github.com/Scotlight/trans-criptase "$env:USERPROFILE/.claude/skills/trans"
cd "$env:USERPROFILE/.claude/skills/trans"
# macOS/Linux: git clone https://github.com/Scotlight/trans-criptase ~/.claude/skills/trans && cd ~/.claude/skills/trans

# 2. One-shot setup: generate config + register MCP. Pick any of three ways:
./install.ps1                                                # no args → interactive wizard (pick a tier, fill each field)
./install.ps1 -BaseUrl https://your-endpoint/v1 -ApiKey sk-xxx   # args, one-liner (macOS/Linux: ./install.sh --baseUrl ... --apiKey ...)
./install.ps1 -Provider local -LocalDtype q8                 # local-model tier (download the model separately, see docs/local-model.md)
#   The script prints the real paths of plugin root / config / index / MCP at the end, for later debugging.

# 3. Build the index + verify
node scripts/semantic.mjs index --force                      # with embedding: full vector index
node scripts/semantic.mjs query "error text or a variable name" --exact   # works with zero config: pure keyword, no API
```

> **Don't want the key in a file?** Skip `-ApiKey` and set the env var `TRANS_EMBED_API_KEY` instead (`setx TRANS_EMBED_API_KEY "sk-xxx"` on Windows, or write it into your shell profile on macOS/Linux). It takes precedence over the config file, so the key never lands in a file, a conversation, or the transcript index. `TRANS_EMBED_BASE_URL` / `TRANS_EMBED_MODEL` etc. work the same way.

Next new Claude Code session you'll get the `/trans:trans` skill, 5 MCP tools (`trans_search` / `trans_scan` / `trans_list` / `trans_expand` / `trans_index`), and background incremental indexing at the end of every session (the SessionEnd hook).

> **Why clone into `~/.claude/skills/trans` rather than "anywhere + an install script"?** Because a skills-dir plugin auto-loads from that location. This way the hook is defined in the plugin's own `hooks/hooks.json`, physically isolated from your `settings.json` — swapping providers or rewriting `settings.json` won't clobber it. The folder must be named `trans` (scripts and index are located by it).
>
> For `--plugin-dir` temporary testing or marketplace distribution, see the [Claude Code plugin docs](https://code.claude.com/docs/en/plugins).

### Or: let the AI install it (recommended)

Copy the block below and hand it to Claude Code; it takes care of the rest:

```text
Please install and configure transcriptase (a Claude Code session-transcript search/resume tool, repo: https://github.com/Scotlight/trans-criptase). Go step by step; verify each step succeeds before the next:

1. Clone the repo into ~/.claude/skills/trans (the folder MUST be named trans — a skills-dir plugin auto-loads from that location). Then run the install script in that directory: on Windows run ./install.ps1 with pwsh, on macOS/Linux run bash install.sh. It does only two things: generate embed-config.json, and register an MCP server named trans via claude mcp add (it does NOT touch my settings.json). Confirm the clone finished and both steps succeeded. Note: the plugin's /trans:trans skill and SessionEnd hook need no extra registration — they take effect next session. Do not edit my settings.json.

2. Verify the base pipeline with zero config: in ~/.claude/skills/trans run
   node scripts/semantic.mjs index --no-embed
   then search a keyword that appeared in one of my recent sessions:
   node scripts/semantic.mjs query "<that keyword>" --exact
   It passes only if there are hits.

3. Ask me which embedding tier (ask only once):
   a) Remote API — you MAY run the install script with baseUrl/model args for me (those are not secrets), but the apiKey must never pass through you: let me choose — either I open ~/.claude/skills/trans/embed-config.json and fill apiKey myself, or I set the env var TRANS_EMBED_API_KEY in my terminal (the key never enters the conversation/file/index and takes precedence over the file). baseUrl should be an OpenAI-compatible endpoint ending in /v1; recommended model BAAI/bge-m3, optional reranker BAAI/bge-reranker-v2-m3.
   b) Local model (zero cloud) — walk me through the six steps in docs/local-model.md; I need to download the model files manually, and you validate the placement and config.
   c) Keyword only for now — skip this step and step 4.

4. After config, run node scripts/semantic.mjs index --force to build the vector index, then test query with a semantic question (not an exact keyword) and show me the hits to confirm quality.

5. To wrap up, tell me in a few sentences: when each of the 5 MCP tools (trans_search / trans_expand / trans_scan / trans_list / trans_index) gets used, how /trans:trans is triggered, and that the SessionEnd hook incrementally indexes the just-ended session after each of my sessions (only for projects already indexed, skipping the currently-active session, with a budget cap, so it never slows down searches). Remind me all of this takes effect only in a new session.

Hard constraints: never print my apiKey into the conversation, command-line args, or logs; treat transcripts under ~/.claude/projects as read-only, never modify them; stop and report on any step failure — do not push through broken.
```

## Configuration

Three tiers, pick as needed:

| Tier | Needs | Capability |
|---|---|---|
| **Zero-config** | nothing | keyword/substring search (`--exact`), works natively for CJK |
| **Remote API** | any OpenAI-compatible embedding endpoint | + semantic/hybrid search; recommend `BAAI/bge-m3` (best for Chinese), optional `bge-reranker-v2-m3` rerank |
| **Local model** | download an ONNX model once (~24–450MB) | same as above, but **fully offline** (`allowRemoteModels=false` hard-locked) → [local setup guide](docs/local-model.md) |

`embed-config.example.json`:

```jsonc
{
    "provider": "api",              // "api" or "local"
    "baseUrl": "https://your-endpoint/v1",
    "apiKey": "sk-...",
    "model": "BAAI/bge-m3",
    "rerankModel": "BAAI/bge-reranker-v2-m3",   // leave empty to skip rerank
    "localEmbedder": "embedder/embedder.mjs",   // used when provider=local
    "localDtype": "fp32"
}
```

### Three ways to write the config

**1. install-script args (personal one-liner, non-interactive)**

```powershell
./install.ps1 -BaseUrl https://your-endpoint/v1 -ApiKey sk-xxx     # remote API tier
./install.ps1 -Provider local -LocalDtype q8                       # local-model tier
```

macOS/Linux long options: `./install.sh --baseUrl ... --apiKey ...`. The script calls `scripts/write-config.mjs` to persist, and apiKey is masked in the log.

**2. Environment variables (key never lands in file/conversation/transcript — safest)**

Any config field can be overridden by an env var of the same purpose, taking precedence over the file. The most useful is keeping `apiKey` in an env var only — leave that line empty in `embed-config.json`:

| Env var | Overrides |
|---|---|
| `TRANS_EMBED_API_KEY` | apiKey |
| `TRANS_EMBED_BASE_URL` | baseUrl |
| `TRANS_EMBED_MODEL` / `TRANS_RERANK_MODEL` | model / rerankModel |
| `TRANS_EMBED_PROVIDER` / `TRANS_LOCAL_EMBEDDER` | provider / localEmbedder |

```powershell
setx TRANS_EMBED_API_KEY "sk-xxx"     # Windows, takes effect on a new terminal
export TRANS_EMBED_API_KEY=sk-xxx     # macOS/Linux, write into your shell rc
```

> **Why this matters especially for trans**: trans indexes exactly the `~/.claude/projects/*.jsonl` transcripts. Once a key enters the conversation, trans will chunk it, embed it, write it into `index/` in plaintext, and send it as text-to-embed to your endpoint. So when letting the AI install this, **never hand it the key** — use an env var, or open the file and fill it yourself.

**3. Manual edit**: `cp embed-config.example.json embed-config.json` and fill it in. The file is already blocked by `.gitignore`, so it won't be committed by accident.

## Usage

### MCP tools (recommended, model calls them automatically)

| Tool | Does what |
|---|---|
| `trans_search` | fuzzy-search old session details; **auto incremental-refresh before searching**, zero maintenance |
| `trans_expand` | expand context around `sessionId:line` |
| `trans_scan` | produce the session resumption brief (five-part report) |
| `trans_list` | list candidate sessions (mtime desc + first-message preview) |
| `trans_index` | build/rebuild the index manually |

### CLI

```powershell
node scripts/semantic.mjs query "pinned sidebar drag width"   # hybrid (vector + keyword RRF)
node scripts/semantic.mjs query "..." --exact                # pure keyword, no API
node scripts/semantic.mjs query "..." --rerank               # add rerank
node scripts/semantic.mjs query "..." --all                  # across all projects
node scripts/semantic.mjs index                              # incremental index (seconds)
pwsh scripts/scan-transcript.ps1 -Id <session-prefix>        # resumption brief (also -List)
```

### Search wisdom

Rerank score < 0.5 = you didn't catch the real one. **Rephrase and re-search**, using the words the person actually used at the time: what "two windows overwriting each other" won't find, "another session clobbered my refactor" nails in one shot. For variable names and error strings, use `--exact`.

## Architecture

```
~/.claude/projects/<project>/*.jsonl     transcripts (read-only, never modified)
        │  parse: filter noise/tool output, chunk (800 chars / 720 stride)
        ▼
index/<project>/  meta.jsonl + vec.bin   plaintext chunks + normalized vectors (binary)
        │  state.json records lines processed per session → incremental index embeds only new
        ▼
query: vector dot-product top200 ─┐
       keyword substring top200 ──┴→ RRF fusion → (optional rerank) → sessionId:line
```

- The index is **local files**, no database dependency; 757 chunks ≈ 3MB
- lib.mjs / mcp-server.mjs have zero npm dependencies (node ≥ 18); the MCP server is hand-written stdio JSON-RPC
- The local-model option uses transformers.js (ONNX), with dependencies isolated in `embedder/` — not installing it doesn't affect anything else

### Plugin file layout

```
~/.claude/skills/trans/           ← clone here; skills-dir plugin auto-loads
├── .claude-plugin/plugin.json    plugin manifest (name=trans → namespace /trans:trans)
├── SKILL.md                      session-resumption skill
├── hooks/hooks.json              SessionEnd → background incremental index (no settings.json)
├── .mcp.json                     plugin-level MCP declaration (not required if you use claude mcp add)
├── embed-config.json             your config (has the key, blocked by .gitignore)
├── index/                        vector index (plaintext chunks, blocked by .gitignore)
├── scripts/                      lib.mjs / mcp-server.mjs / semantic.mjs / session-end-index.mjs / scan-transcript.ps1
└── embedder/                     local-model option (transformers.js + your own model files)
```

The three components register in different ways, **by design**: the hook goes through the plugin's own `hooks/hooks.json`, physically isolated from your `settings.json` (swapping providers or rewriting settings can't clobber it); the skill auto-loads with the plugin directory; MCP goes through one `claude mcp add` for rock-solid unconditional global mounting. Scripts derive their own location via `import.meta.url`, so the plugin locates config and index no matter where it's installed.

## FAQ

**Q: HuggingFace model download returns 403?**
HF's Xet CDN (`cas-bridge.xethub.hf.co`) denies access from some network egresses, and hf-mirror doesn't proxy it. Download the model files manually from a mirror like ModelScope and drop them into `embedder/models/<model-id>/` — the local option is designed for exactly this "bring your own files, load fully offline." See the [local setup guide](docs/local-model.md).

**Q: Is the index safe?**
`index/` holds **plaintext chunks of all your conversations**. It only lives locally, but if you use remote embedding, the chunk text is sent to your configured API endpoint — if that bothers you, use a local model or the keyword-only tier. `.gitignore` already blocks index, models, and the real config; don't force-add them.

**Q: Cost?**
bge-m3-class embedding is dirt cheap: a full index of 700+ chunks is ~500K input tokens once, then incremental is nearly free; each query is ~50–200 tokens.

**Q: Cross-platform?**
The core (MCP/CLI) is pure Node, works on all three platforms. `scan-transcript.ps1` needs pwsh and is a fallback — the MCP `trans_scan` is its cross-platform equivalent.

## License

MIT
