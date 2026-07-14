#Requires -Version 7
# transcriptase 克隆后一键 setup（在克隆好的 skill 目录里跑）
#   前提：已把本仓库克隆到 ~/.claude/skills/trans（插件靠这个位置自动加载）
#   本脚本只做两件「克隆不包含」的事：生成 embed-config.json + 注册 MCP 服务器
#   —— 不再拷贝文件：插件形态下 plugin.json / hooks/ 必须原地保留，拷走就废了
#
# 无参跑：生成配置模板（自己稍后编辑填 key）。
# 带参跑（个人一行到位，非交互）：
#   ./install.ps1 -BaseUrl https://你的中转/v1 -ApiKey sk-xxx
#   ./install.ps1 -Provider local -LocalDtype q8        # 本地模型档
# 也可把 key 留空、改用环境变量 TRANS_EMBED_API_KEY（key 永不落文件，见 README）。
param(
    [ValidateSet('api', 'local')][string]$Provider,
    [string]$BaseUrl,
    [string]$ApiKey,
    [string]$Model,
    [string]$RerankModel,
    [string]$LocalDtype
)
$ErrorActionPreference = 'Stop'
$skillDir = $PSScriptRoot
$expectedDir = Join-Path $HOME '.claude\skills\trans'

if ($skillDir -ne $expectedDir) {
    Write-Host "⚠ 当前目录不是 $expectedDir" -ForegroundColor Yellow
    Write-Host "  插件靠这个固定位置自动加载。请改为克隆到该位置："
    Write-Host "  git clone <repo> `"$expectedDir`""
    Write-Host "  然后在该目录里重跑本脚本。继续在当前位置 setup 也可，但 skill/hook 不会自动加载。"
}

# 1. 生成/更新配置：把传入参数转成 write-config.mjs 的 --key value（单一真相，PS/bash 共用）
$cfgArgs = @()
foreach ($p in @(
        @('provider', $Provider), @('baseUrl', $BaseUrl), @('apiKey', $ApiKey),
        @('model', $Model), @('rerankModel', $RerankModel), @('localDtype', $LocalDtype))) {
    if ($p[1]) { $cfgArgs += "--$($p[0])"; $cfgArgs += $p[1] }
}
node (Join-Path $skillDir 'scripts\write-config.mjs') @cfgArgs

# 2. 注册 MCP 服务器（user 级；skill/hook 走插件自动加载，不在此处理）
$server = Join-Path $skillDir 'scripts\mcp-server.mjs'
if (Get-Command claude -ErrorAction SilentlyContinue) {
    try {
        claude mcp add --scope user trans -- node $server
    } catch {
        Write-Host "MCP 注册失败（可能已注册过）。手动执行：claude mcp add --scope user trans -- node `"$server`""
    }
} else {
    Write-Host "未找到 claude CLI。手动注册：claude mcp add --scope user trans -- node `"$server`""
}

Write-Host ''
Write-Host '完成。下次新开 Claude Code 会话生效：'
Write-Host '  • /trans:trans skill 与 SessionEnd 后台索引 hook —— 随插件自动加载（不写 settings.json）'
Write-Host '  • 5 个 MCP 工具（trans_search/scan/list/expand/index）'
Write-Host '零配置先体验：node scripts/semantic.mjs index --no-embed; node scripts/semantic.mjs query "关键词" --exact'
