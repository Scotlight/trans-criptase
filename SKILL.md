---
name: trans
description: 转录续接（DNA 式 transcription）：把中断/旧会话的 JSONL 转录读出来，提取「原任务 → 已完成 → 断点 → 剩余」，报告后接着干。当用户说「/trans / 恢复会话 / 接着上次 / 续接 xxx 会话 / resume session / 上次聊到哪了」或给出会话 UUID 要求继续时使用。
argument-hint: "[会话ID或前缀] [尾部记录数，默认60]"
---

# /trans —— 会话转录续接

DNA 中心法则的打法：**转录**（把死掉会话的 JSONL 读成情报）→ **翻译**（产出续接报告）→ **表达**（接着干活）。全程只读转录文件，绝不修改它。

> **MCP 优先**：若本会话连接了 `trans` MCP 服务器（工具 `trans_scan` / `trans_list` / `trans_search` / `trans_expand` / `trans_index`），直接调工具，跳过下面的脚本命令；语义等价，工具还会自动增量刷新索引。下述脚本是 MCP 不可用时的兜底。

## 1. 转录：跑扫描脚本（一次调用出全套情报）

> MCP 可用时：`trans_scan({id})` 等价此步；不知道恢复哪个会话先 `trans_list()`。

```powershell
& "$env:USERPROFILE\.claude\skills\trans\scripts\scan-transcript.ps1" -Id <ID前缀>
```

| 参数 | 作用 |
|---|---|
| `-Id <前缀>` | 会话 UUID 或前缀；先在当前项目找，找不到跨项目全局找 |
| （不带参数） | 自动取当前项目**次新**转录（最新那个是正在写的当前会话，自动跳过） |
| `-List` | 只列候选会话（mtime 降序 + 首条用户消息预览），用户没给 ID 又拿不准时先跑这个 |
| `-Tail <n>` | 尾部概览记录数，默认 60 |
| `-MaxMsgs <n>` | 用户消息脉络显示条数，默认 60，`0` = 全量 |
| `-Detail <行号>` | 手动改断点明细的锚点（默认自动取最后一条任务性用户消息，已排除 Continue from where you left off / [Request interrupted] / 纯图片 / 裸 #标记 这类控制噪音） |
| `-Path <路径>` | 直接指定转录文件，跳过发现逻辑 |
| `-Project <路径>` | 替别的项目目录解析（默认 cwd） |

输出五段：**会话文件**（体量）→ **压缩摘要**（若有）→ **用户消息脉络**（带行号+时间，重建任务轨迹）→ **尾部概览**（断在哪）→ **断点明细**（锚点后 assistant 全部动作，含 Edit/Write 完整 input，即半成品的精确边界）。

超长会话输出被截时：调小 `-MaxMsgs`/`-Tail` 分次跑，或用 `-Detail` 只看断点段。

## 2. 手动兜底（脚本丢失/损坏时）

转录在 `~/.claude/projects/<编码>/*.jsonl`，编码 = 项目 cwd **所有非字母数字字符替换为 `-`**。每行一条 JSON：`type` ∈ `user`/`assistant`/`summary`；`message.content` 为字符串或块数组（`text`/`tool_use`/`tool_result`）。用 `Get-Content -Tail` + `ConvertFrom-Json` 逐层抽取：先尾部概览，再全量真实用户消息（过滤 `^\s*<` 噪音和 `isSidechain`），最后从末条任务消息起提取 assistant 的 tool_use input。**大文件绝不整读进上下文。**

## 3. 校对：与磁盘对账（必做）

**转录 ≠ 磁盘事实。** 转录里"已完成"的编辑必须逐条核实是否真的落盘、有没有被后续会话覆盖：

1. `git status --short` + `git diff --stat`——工作树里的东西是不是恰好等于断点明细声称的改动
2. 断点明细里每个 Edit/Write，用 Read/`git diff <file>` 验证现状
3. 工作树有转录解释不了的改动 → **停下报告**，按多会话冲突处理，不要盖着写

## 4. 翻译并表达：出续接报告，然后继续

报告四段：**原任务是什么 → 已完成并核实的部分 → 中断点（精确到哪个文件哪一步） → 剩余步骤**。

然后按当前项目规则续接：目标项目若有写入闸门/审批约定（通常在其 CLAUDE.md 硬性规则里），先出方案提醒、确认后再动；没有就直接继续。续接时沿用原会话的方案与命名，不要另起炉灶。

## 5. 语义检索：跨会话模糊查旧细节（可选增强）

场景：用户提到一个当前上下文（最新 N 条）里没有的旧细节——「上次那个字体迁移怎么弄的」「之前提过的 WebDAV CORS 问题」——但记不清在哪个会话。用向量检索模糊召回，拿到 `会话ID:行号` 后再放大。

> MCP 可用时：`trans_search({query})` → 命中后 `trans_expand({sessionId, line})`，搜索前索引自动增量刷新，无需手动维护。以下命令行为兜底。

**一次性配置**：编辑 `~/.claude/skills/trans/embed-config.json` 填 `baseUrl`（OpenAI 兼容、以 `/v1` 结尾）和 `apiKey`；或设环境变量 `TRANS_EMBED_BASE_URL` / `TRANS_EMBED_API_KEY`（推荐，避免 key 落文件）。默认模型 `BAAI/bge-m3`（中文检索最优），rerank 默认 `BAAI/bge-reranker-v2-m3`。

```powershell
# 建/更新当前项目索引（增量：只处理新增行，mtime 未变的会话跳过）
node "$env:USERPROFILE\.claude\skills\trans\scripts\semantic.mjs" index
node ...\semantic.mjs index --no-embed # 纯关键词索引，零 API 零成本（查询只能用 --exact）
node ...\semantic.mjs index --dry      # 只算新增块数、不调 API（先估成本）
node ...\semantic.mjs index --all      # 索引全部项目
node ...\semantic.mjs index --force    # 换模型/换模式或索引损坏时全量重建

# 查询：输出 分数 / 会话ID:行号 / 角色时间 / 预览。默认混合（向量+关键词 RRF 融合）
node ...\semantic.mjs query "字体迁移到专用表" --top 8
node ...\semantic.mjs query "..." --exact       # 纯关键词/子串（变量名、报错串；无需 API）
node ...\semantic.mjs query "..." --semantic    # 纯向量（概念模糊查询）
node ...\semantic.mjs query "..." --rerank      # 召回后用 reranker 精排，质量最高
node ...\semantic.mjs query "..." --all         # 跨所有项目找

node ...\semantic.mjs status           # 各项目索引的模型/维度/块数/体积
```

命中后：`scan-transcript.ps1 -Id <会话前缀> -Detail <行号>` 放大那一段的完整上下文。

要点：向量二进制存 `~/.claude/skills/trans/index/<项目编码>/`，不入任何库；增量索引靠 `state.json` 记录每会话已处理行数；换 embedding 模型会自动触发重建（维度不匹配的查询会被跳过并提示）。
