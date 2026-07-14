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

## Your control

- Choose the keyword-only or local-model tier to keep everything offline.
- Delete the `index/` directory at any time to remove all stored chunks.
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

## 你的控制权

- 选纯关键词或本地模型档，即可全程离线。
- 随时删除 `index/` 目录即可清除所有已存切块。
- API key 可通过 `TRANS_EMBED_API_KEY` 环境变量提供，从而永不写入磁盘。

## 联系

问题反馈：https://github.com/Scotlight/trans-criptase/issues
