# transcriptase 转录酶

[English](README.md) | **简体中文**

[![LINUX DO](https://img.shields.io/badge/LINUX%20DO-社区-ffb003?logo=discourse&logoColor=white)](https://linux.do)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> 让 Claude Code 记得住自己说过的话。

Claude Code 的每个会话都会在本地留下完整转录（JSONL），但官方只给了一个 `--resume` 平铺列表——找不到、搜不了、断了接不上。transcriptase 把这堆沉睡的转录变成两样东西：**可续接的现场**，和**可检索的记忆**。

名字来自逆转录酶（reverse transcriptase）：别人把对话转录成文件，我们把文件逆转录回活的上下文。

## 三个能力

**1. 会话续接（/trans）**
会话断了、context 爆了、电脑重启了？一条命令扫描旧会话转录，产出五段续接情报：

```
会话体量 → 压缩摘要 → 用户消息脉络(带行号) → 尾部概览 → 断点明细(含每次 Edit/Write 的完整内容)
```

断点明细能精确到「上次改到哪个文件的哪一步、哪条编辑没落盘」，新会话直接接着干，而不是重新踩一遍。

**2. 跨会话语义检索**
「上次那个字体迁移怎么弄的？」「之前哪个会话里说过撞车的事？」——当前上下文里没有，但转录里有。混合检索（向量 + 关键词 RRF 融合，可选 reranker 精排）模糊召回，返回 `会话ID:行号`。

**3. 行级上下文放大**
检索命中后，按 `会话ID:行号` 拉出该位置前后的完整记录（含工具调用与结果），把旧细节**回注到当前对话**继续干活——不是让你跳去 resume 一个 context 早就爆掉的死会话。

三个能力全部同时以 **MCP 工具 + CLI + Claude Code skill** 三种形态提供，三种触发方式：显式打 `/trans`、直接调 MCP 工具，或让 `UserPromptSubmit` hook 提醒模型——当你的消息透出续接意图（"上次…""那个会话…""接着上次…"）时，hook 注入一条软提示，由模型自行判断是否真要检索/扫描。不会在你背后偷偷触发；提示只是建议，你也随时能手动驱动。

## 实测演示

真实截图，不是模拟。hook 的关键在于它只**提示**——最终由模型决定。

**1. 说一句"昨天干了啥"，它自己就把会话翻出来续上。** `昨天` 命中触发提示，模型连着调 `trans`，逐个往前扫会话（最近那个只是 `/plugin` 命令，于是继续往前挖），最后交出昨天六个会话的实质总结。

<p align="center">
  <img src="https://raw.githubusercontent.com/Scotlight/trans-criptase/main/assets/showcase-1-auto-resume.png" alt="问昨天干了啥，trans 自动往前扫会话并总结" width="760">
</p>

**2. 词表命中也不会误触发。** "昨天天气"同样含 `昨天`，hook 照样注入了提示——但模型读完整条消息，发现跟会话历史无关，于是反问你所在城市，而不是瞎调工具。提示只是建议，正如设计。

<p align="center">
  <img src="https://raw.githubusercontent.com/Scotlight/trans-criptase/main/assets/showcase-2-no-false-trigger.png" alt="问昨天天气不会触发工具调用，模型改为反问城市" width="760">
</p>

**3. 让它别用工具，它老实承认查不了。** 明确说"不用任何工具/插件/skills/MCP"，它坦白自己没有昨天的记忆、也够不到 `git log` 或文件系统——然后主动提出可以**用**这些工具帮你查。这正是 transcriptase 要解决的基线。

<p align="center">
  <img src="https://raw.githubusercontent.com/Scotlight/trans-criptase/main/assets/showcase-3-no-tools-baseline.png" alt="被要求不用工具时，模型老实说查不了昨天并建议 git log 或 trans 插件" width="760">
</p>


## 快速开始

### 方式 A：通过插件市场一键安装（推荐）

本仓库同时是一个 Claude Code 插件**市场**。添加一次，然后安装：

```shell
/plugin marketplace add Scotlight/trans-criptase
/plugin install trans@trans-criptase
```

skill + SessionEnd hook 到此即可（随插件加载，**不写你的 `settings.json`**）。语义/混合检索仍需配置一次 embedding（见[配置](#配置)）；MCP 服务器可用 `claude mcp add` 注册（见方式 B 第 2 步），或走插件自带的 `.mcp.json`。

### 方式 B：克隆到 skills 目录（开发 / 自定义用）

transcriptase 是一个 **Claude Code skills-dir 插件**：克隆到 `~/.claude/skills/` 下，下次会话自动加载（skill + SessionEnd hook 随插件生效，**不写你的 `settings.json`**）。MCP 工具走一条 `claude mcp add` 注册。

```powershell
# 1. 克隆到 skills 目录（目录名必须叫 trans）
git clone https://github.com/Scotlight/trans-criptase "$env:USERPROFILE/.claude/skills/trans"
cd "$env:USERPROFILE/.claude/skills/trans"
# macOS/Linux: git clone https://github.com/Scotlight/trans-criptase ~/.claude/skills/trans && cd ~/.claude/skills/trans

# 2. 一键 setup：生成配置 + 注册 MCP。三种用法任选：
./install.ps1                                                # 无参 → 交互向导，问你选哪档、逐项填
./install.ps1 -BaseUrl https://你的中转/v1 -ApiKey sk-xxx     # 带参一行到位（macOS/Linux: ./install.sh --baseUrl ... --apiKey ...）
./install.ps1 -Provider local -LocalDtype q8                 # 本地模型档（模型文件另下，见 docs/local-model.md）
#   脚本结尾会打印插件根目录/配置/索引/MCP 的实际路径，便于二次调试

# 3. 建索引 + 验证
node scripts/semantic.mjs index --force                      # 有 embedding：全量向量索引
node scripts/semantic.mjs query "报错信息或变量名" --exact    # 零配置也能用：纯关键词，免 API
```

> **不想让 key 落进文件？** 别传 `-ApiKey`，改设环境变量 `TRANS_EMBED_API_KEY`（`setx TRANS_EMBED_API_KEY "sk-xxx"`，macOS/Linux 写进 shell profile）。它优先于配置文件，key 永不进文件、对话或转录索引。同理 `TRANS_EMBED_BASE_URL` / `TRANS_EMBED_MODEL` 等也可走环境变量。

下次新开的 Claude Code 会话里会出现 `/trans:trans` skill、5 个 MCP 工具（`trans_search` / `trans_scan` / `trans_list` / `trans_expand` / `trans_index`）、一个提示续接意图的 `UserPromptSubmit` hook，以及每次会话结束时的后台增量索引（SessionEnd hook）。

> **为什么克隆进 `~/.claude/skills/trans` 而不是随便找地方 + install 脚本？** 因为 skills-dir 插件靠这个位置自动加载。这样 hook 定义在插件自己的 `hooks/hooks.json` 里，和你的 `settings.json` 物理隔离——频繁换供应商、重写 `settings.json` 都不会冲掉它。目录名必须是 `trans`（脚本与索引按此定位）。
>
> `--plugin-dir` 临时测试或 marketplace 分发见 [Claude Code 插件文档](https://code.claude.com/docs/en/plugins)。

### 或者：让 AI 自己装（推荐）

把下面整段复制，丢给 Claude Code，剩下的它自己搞定：

```text
请帮我安装并配置 transcriptase（Claude Code 会话转录检索/续接工具，仓库：https://github.com/Scotlight/trans-criptase）。逐步执行，每步验证成功再进下一步：

1. 把仓库克隆到 ~/.claude/skills/trans（目录名必须叫 trans，skills-dir 插件靠这个位置自动加载）。然后在该目录里跑安装脚本：Windows 用 pwsh 跑 ./install.ps1，macOS/Linux 跑 bash install.sh——它只做两件事：生成 embed-config.json、用 claude mcp add 注册名为 trans 的 MCP 服务器（不碰我的 settings.json）。确认克隆完成、脚本两步都成功。注意：插件的 /trans:trans skill 和 SessionEnd hook 无需任何额外注册，下次会话自动生效，不要去改我的 settings.json。

2. 零配置验证基础链路：在 ~/.claude/skills/trans 目录跑
   node scripts/semantic.mjs index --no-embed
   然后用一个我最近会话里出现过的关键词跑
   node scripts/semantic.mjs query "<那个关键词>" --exact
   有命中结果才算通过。

3. 问我选哪一档 embedding（只问这一次）：
   a) 远程 API —— 你可以直接用 baseUrl/model 参数帮我跑 install 脚本（这些不是秘密），但 apiKey 绝不经过你：让我二选一——要么我自己打开 ~/.claude/skills/trans/embed-config.json 填 apiKey，要么我在终端设环境变量 TRANS_EMBED_API_KEY（key 永不进对话/文件/索引，优先于配置文件）。baseUrl 用 OpenAI 兼容端点、以 /v1 结尾，模型推荐 BAAI/bge-m3，可选精排 BAAI/bge-reranker-v2-m3。
   b) 本地模型（零上云）—— 按仓库里 docs/local-model.md 的六步带我走完，模型文件需要我手动下载，你负责校验目录摆放和配置。
   c) 暂时只用关键词档 —— 跳过本步和第 4 步。

4. 配置完成后跑 node scripts/semantic.mjs index --force 建向量索引，再用一个语义化的问题（不是精确关键词）实测 query，把命中结果展示给我确认质量。

5. 收尾时用几句话告诉我：trans_search / trans_expand / trans_scan / trans_list / trans_index 这 5 个 MCP 工具分别什么时候会被用到，/trans:trans 怎么触发，以及 SessionEnd hook 会在我每次结束会话后自动增量索引刚结束的那个会话（只维护已建过索引的项目、不碰当前活跃会话、带预算上限，所以不拖慢查询）。提醒我这些都要新开会话才生效。

硬性约束：全程绝不把我的 apiKey 打印到对话、命令行参数或日志里；~/.claude/projects 下的转录文件只读，绝不修改；每一步失败就停下来报告，不要带病继续。
```

## 配置

三档，按需选：

| 档位 | 需要什么 | 能力 |
|---|---|---|
| **零配置** | 无 | 关键词/子串检索（`--exact`），中文原生可用 |
| **远程 API** | 任意 OpenAI 兼容 embedding 端点 | + 语义/混合检索；推荐 `BAAI/bge-m3`（中文最优），可选 `bge-reranker-v2-m3` 精排 |
| **本地模型** | 手动下载一次 ONNX 模型（~24-450MB） | 同上，但**全程零上云**（`allowRemoteModels=false` 焊死）→ [本地配置教程](docs/local-model.md) |

`embed-config.example.json`：

```jsonc
{
    "provider": "api",              // "api" 或 "local"
    "baseUrl": "https://你的中转/v1",
    "apiKey": "sk-...",
    "model": "BAAI/bge-m3",
    "rerankModel": "BAAI/bge-reranker-v2-m3",   // 留空则不精排
    "localEmbedder": "embedder/embedder.mjs",   // provider=local 时用
    "localDtype": "fp32"
}
```

### 三种写配置的方式

**1. install 脚本传参（个人一行到位，非交互）**

```powershell
./install.ps1 -BaseUrl https://你的中转/v1 -ApiKey sk-xxx          # 远程 API 档
./install.ps1 -Provider local -LocalDtype q8                       # 本地模型档
```

macOS/Linux 同名长选项：`./install.sh --baseUrl ... --apiKey ...`。脚本调 `scripts/write-config.mjs` 落盘，apiKey 在日志里隐藏。

**2. 环境变量（key 永不落文件/对话/转录，最安全）**

任一配置项都能被同名环境变量覆盖，优先级高于文件。最有用的是让 `apiKey` 只活在环境变量里——`embed-config.json` 里那行留空即可：

| 环境变量 | 覆盖 |
|---|---|
| `TRANS_EMBED_API_KEY` | apiKey |
| `TRANS_EMBED_BASE_URL` | baseUrl |
| `TRANS_EMBED_MODEL` / `TRANS_RERANK_MODEL` | model / rerankModel |
| `TRANS_EMBED_PROVIDER` / `TRANS_LOCAL_EMBEDDER` | provider / localEmbedder |

```powershell
setx TRANS_EMBED_API_KEY "sk-xxx"     # Windows，重开终端生效
export TRANS_EMBED_API_KEY=sk-xxx     # macOS/Linux，写进 shell rc
```

> **为什么这对 trans 尤其重要**：trans 索引的就是 `~/.claude/projects/*.jsonl` 转录。key 一旦进了对话，会被 trans 自己切块、embed、写进 `index/` 明文，还会作为待嵌入文本发给你的 embedding 端点。所以让 AI 装时**绝不能把 key 交给它**——走环境变量，或你自己开文件填。

**3. 手动编辑**：`cp embed-config.example.json embed-config.json` 后直接填。文件已被 `.gitignore` 拦，不会误提交。

## 用法

### MCP 工具

模型会在合适时机自己调（`UserPromptSubmit` hook 会提醒它去检索/扫描——见下），你也可以显式调用。

| 工具 | 干什么 |
|---|---|
| `trans_search` | 模糊检索旧会话细节；**搜索前自动增量刷新索引**，零维护 |
| `trans_expand` | 按 `会话ID:行号` 放大上下文 |
| `trans_scan` | 产出会话续接情报（五段报告） |
| `trans_list` | 列候选会话（mtime 降序 + 首条消息预览） |
| `trans_index` | 手动建/重建索引 |

### CLI

```powershell
node scripts/semantic.mjs query "钉住侧栏拖拽宽度"            # 混合（向量+关键词 RRF）
node scripts/semantic.mjs query "..." --exact                # 纯关键词，免 API
node scripts/semantic.mjs query "..." --rerank               # 加精排
node scripts/semantic.mjs query "..." --all                  # 跨所有项目
node scripts/semantic.mjs index                              # 增量索引（秒级）
pwsh scripts/scan-transcript.ps1 -Id <会话前缀>              # 续接情报（也可 -List）
```

### 自动触发 hook

插件自带一个 `UserPromptSubmit` hook（`scripts/prompt-hint.mjs`）。每次你发消息，它扫续接/回忆意图——`昨天` / `上次` / `之前说` / `记得…做` / `接着上次` / `恢复会话`，以及英文 `last time` / `pick up where` / `previous session`，还有裸的会话 UUID 片段。命中就往模型上下文注入一条建议提示 `trans_scan` / `trans_search`；模型读完整条消息再决定是否真需要。不命中（或输入畸形）静默退出，零副作用。不会自动开火——hook 只**提示**。

### 检索心法

精排分数 < 0.5 = 没捞到正主。**换措辞重查**，尽量用当事人当时会用的词：「两个窗口互相覆盖」查不到的东西，「另一个会话把重构覆盖了」一发入魂。抓变量名、报错串用 `--exact`。

## 架构

```
~/.claude/projects/<项目>/*.jsonl        转录（只读，绝不修改）
        │  解析：过滤噪音/工具输出，切块(800字/720步长)
        ▼
index/<项目>/  meta.jsonl + vec.bin      切块明文 + 归一化向量(二进制)
        │  state.json 记录每会话已处理行数 → 增量索引只embed新增
        ▼
查询：向量点积 top200 ─┐
      关键词子串 top200 ─┴→ RRF 融合 → (可选 rerank) → 会话ID:行号
```

- 索引是**本地文件**，无数据库依赖；757 块 ≈ 3MB
- lib.mjs / mcp-server.mjs 零 npm 依赖（node ≥ 18）；MCP 服务器是手写 stdio JSON-RPC
- 本地模型方案用 transformers.js(ONNX)，依赖隔离在 `embedder/`，不装不影响其他功能

### 插件文件结构

```
~/.claude/skills/trans/           ← 克隆到这里，skills-dir 插件自动加载
├── .claude-plugin/plugin.json    插件清单（name=trans → 命名空间 /trans:trans）
├── SKILL.md                      会话续接 skill
├── hooks/hooks.json              UserPromptSubmit → 续接意图提示；SessionEnd → 后台增量索引（不写 settings.json）
├── .mcp.json                     插件级 MCP 声明（用 claude mcp add 时可不依赖它）
├── embed-config.json             你的配置（含 key，.gitignore 拦住）
├── index/                        向量索引（明文切块，.gitignore 拦住）
├── scripts/                      lib.mjs / mcp-server.mjs / semantic.mjs / prompt-hint.mjs / session-end-index.mjs / scan-transcript.ps1
└── embedder/                     本地模型方案（transformers.js + 模型文件自备）
```

三种组件的注册方式各不相同，这是**刻意设计**：hook 走插件自带的 `hooks/hooks.json`，与你的 `settings.json` 物理隔离（频繁换供应商、重写 settings 都冲不掉它）；skill 随插件目录自动加载；MCP 走一条 `claude mcp add`，全局无条件挂载最稳。脚本用 `import.meta.url` 推导自身位置，所以插件装到任何路径都能定位 config 与 index。

## FAQ

**Q: HuggingFace 模型下载 403？**
HF 的 Xet CDN（`cas-bridge.xethub.hf.co`）对部分网络出口拒绝访问，hf-mirror 也不代理它。换 ModelScope 等镜像源手动下载模型文件，放进 `embedder/models/<模型ID>/` 即可——本地方案本来就设计为「文件自备、加载全离线」。详见[本地配置教程](docs/local-model.md)。

**Q: 索引安全吗？**
`index/` 里是你**全部对话的明文切块**。它只存在于本地，但如果你用远程 embedding，切块文本会发给你配置的 API 端点——介意就用本地模型或纯关键词档。`.gitignore` 已拦住 index、models、真实配置，别手贱 force add。

**Q: 成本？**
bge-m3 级别的 embedding 是白菜价：700+ 块全量索引一次约 50 万 token 输入，之后增量几乎免费；查询每次约 50-200 token。

**Q: 跨平台？**
核心（MCP/CLI）纯 Node，三平台通用。`scan-transcript.ps1` 需要 pwsh，是兜底脚本——MCP 的 `trans_scan` 是它的跨平台等价物。

## License

MIT
