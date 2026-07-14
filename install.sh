#!/usr/bin/env bash
# transcriptase 克隆后一键 setup（在克隆好的 skill 目录里跑）
#   前提：已把本仓库克隆到 ~/.claude/skills/trans（插件靠这个位置自动加载）
#   本脚本只做两件「克隆不包含」的事：生成 embed-config.json + 注册 MCP 服务器
#   —— 不再拷贝文件：插件形态下 plugin.json / hooks/ 必须原地保留，拷走就废了
#
# 无参跑：生成配置模板（自己稍后编辑填 key）。
# 带参跑（个人一行到位，非交互）：
#   ./install.sh --baseUrl https://你的中转/v1 --apiKey sk-xxx
#   ./install.sh --provider local --localDtype q8        # 本地模型档
# 也可把 key 留空、改用环境变量 TRANS_EMBED_API_KEY（key 永不落文件，见 README）。
set -e
skill="$(cd "$(dirname "$0")" && pwd)"
expected="$HOME/.claude/skills/trans"

if [ "$skill" != "$expected" ]; then
    echo "⚠ 当前目录不是 $expected"
    echo "  插件靠这个固定位置自动加载。请改为克隆到该位置："
    echo "  git clone <repo> \"$expected\""
    echo "  然后在该目录里重跑本脚本。继续在当前位置 setup 也可，但 skill/hook 不会自动加载。"
fi

# 1. 生成/更新配置：透传参数给 write-config.mjs（单一真相，PS/bash 共用）
#    接受 --provider/--baseUrl/--apiKey/--model/--rerankModel/--localDtype
node "$skill/scripts/write-config.mjs" "$@"

# 2. 注册 MCP 服务器（user 级；skill/hook 走插件自动加载，不在此处理）
server="$skill/scripts/mcp-server.mjs"
if command -v claude >/dev/null 2>&1; then
    claude mcp add --scope user trans -- node "$server" || echo "MCP 注册失败（可能已注册过）。手动执行：claude mcp add --scope user trans -- node \"$server\""
else
    echo "未找到 claude CLI。手动注册：claude mcp add --scope user trans -- node \"$server\""
fi

echo ""
echo "完成。下次新开 Claude Code 会话生效："
echo "  • /trans:trans skill 与 SessionEnd 后台索引 hook —— 随插件自动加载（不写 settings.json）"
echo "  • 5 个 MCP 工具（trans_search/scan/list/expand/index）"
echo '零配置先体验：node scripts/semantic.mjs index --no-embed; node scripts/semantic.mjs query "关键词" --exact'
