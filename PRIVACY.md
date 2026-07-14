# Privacy Policy

**English** | [简体中文](#隐私政策)

`trans` (project: trans-criptase) is a local-first tool. It reads your Claude Code
session transcripts and builds a local search index. This page explains exactly
what data it touches and where that data goes.

## What it reads

- `~/.claude/projects/**/*.jsonl` — your Claude Code session transcripts, **read-only**.
  The tool never modifies these files.

## What it stores

- A local index under the plugin directory (`index/`): plaintext chunks of your
  conversations plus a binary vector blob. This is **stored on your machine only**.
  It is never uploaded anywhere by the tool itself.
- Your configuration (`embed-config.json`), which may contain an API key. This file
  stays local and is git-ignored. The key can instead live in an environment
  variable so it never lands in a file at all.

## What leaves your machine

This depends entirely on which embedding tier **you choose**:

| Tier | Data that leaves your machine |
|---|---|
| **Keyword-only** (no API key) | **Nothing.** Fully offline. |
| **Local model** (offline ONNX) | **Nothing.** `allowRemoteModels` is hard-locked off. |
| **Remote API** (opt-in) | Chunk text is sent to the OpenAI-compatible endpoint **you configured**, for embedding and optional reranking. Nothing else. |

The tool has no telemetry, no analytics, and makes no network calls of its own
other than to the embedding endpoint you explicitly configure in the remote-API tier.

## Retention & size

- **No automatic eviction.** The index only grows; it is never trimmed, aged out,
  or capped by the tool. It persists until you delete it yourself.
- **Incremental, append-only.** Each session's new lines are appended once
  (tracked per-session in `state.json`); unchanged sessions are skipped, so the
  index never re-grows for content it already holds.
- **Rough size:** plaintext chunks plus normalized float32 vectors run on the
  order of a few MB per thousand chunks (≈757 chunks ≈ 3 MB in practice). It scales
  linearly with how much conversation you index — roughly proportional to the size
  of the transcripts themselves.
- **To reset:** delete `index/<project-encoded>/` to wipe one project, or the whole
  `index/` directory to wipe everything. It rebuilds on the next search/index run.

## Your control

- Choose the keyword-only or local-model tier to keep everything offline.
- Delete the `index/` directory at any time to remove all stored chunks.
- Inspect what's stored: `node scripts/semantic.mjs status` lists per-project
  model / chunk count / index size; the chunks themselves are plaintext in
  `index/<project>/meta.jsonl`.
- The API key can be supplied via the `TRANS_EMBED_API_KEY` environment variable
  so it is never written to disk.

## Contact

Issues: https://github.com/Scotlight/trans-criptase/issues

---

# 隐私政策

[English](#privacy-policy) | **简体中文**

`trans`（项目：trans-criptase）是一个本地优先的工具。它读取你的 Claude Code
会话转录并在本地建立检索索引。本页如实说明它接触哪些数据、数据流向何处。

## 读取什么

- `~/.claude/projects/**/*.jsonl` —— 你的 Claude Code 会话转录，**只读**。
  工具从不修改这些文件。

## 存储什么

- 插件目录下的本地索引（`index/`）：你对话的明文切块 + 二进制向量数据。
  **仅存在于你的机器上**，工具本身绝不上传。
- 你的配置（`embed-config.json`），可能含 API key。该文件保留在本地且被 git 忽略。
  key 也可改由环境变量提供，从而完全不落盘。

## 什么会离开你的机器

完全取决于**你选择**的 embedding 档位：

| 档位 | 离开机器的数据 |
|---|---|
| **纯关键词**（无 key） | **无。** 全程离线。 |
| **本地模型**（离线 ONNX） | **无。** `allowRemoteModels` 已焊死关闭。 |
| **远程 API**（需你主动开启） | 切块文本发送给**你自己配置的** OpenAI 兼容端点，用于 embedding 及可选精排，仅此而已。 |

工具无遥测、无分析，除了远程 API 档位中你显式配置的 embedding 端点外，
自身不发起任何网络请求。

## 保留与体量

- **无自动淘汰。** 索引只增不减，工具不会主动裁剪、按时间过期或设上限，
  它一直保留直到你自己删除。
- **增量、只追加。** 每个会话的新增行只索引一次（在 `state.json` 里按会话记录进度），
  未变动的会话直接跳过，已索引过的内容不会重复增长。
- **大致体量：** 明文切块 + 归一化 float32 向量，量级约为每千块几 MB
  （实测 ≈757 块 ≈ 3 MB）。随你索引的对话量线性增长，大致与转录本身的体量成正比。
- **如何重置：** 删 `index/<项目编码>/` 清除单个项目，或删整个 `index/` 目录清除全部，
  下次检索/索引时自动重建。

## 你的控制权

- 选纯关键词或本地模型档，即可全程离线。
- 随时删除 `index/` 目录即可清除所有已存切块。
- 查看存了什么：`node scripts/semantic.mjs status` 列出每个项目的模型/块数/索引大小；
  切块本身是明文，存于 `index/<项目>/meta.jsonl`。
- API key 可通过 `TRANS_EMBED_API_KEY` 环境变量提供，从而永不写入磁盘。

## 联系

问题反馈：https://github.com/Scotlight/trans-criptase/issues
