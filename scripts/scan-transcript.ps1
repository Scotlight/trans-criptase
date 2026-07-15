#Requires -Version 7
param(
    [string]$Id,
    [string]$Path,
    [string]$Project,
    [switch]$List,
    [int]$Tail = 60,
    [int]$MaxMsgs = 60,
    [int]$Detail = 0,
    [int]$MaxLen = 300
)

$ErrorActionPreference = 'Stop'

# 说明：本脚本是 trans_scan 的 PowerShell 兜底（MCP 不可用时用），Windows-only。
# 覆盖两来源：Claude Code（~/.claude/projects/<enc>/*.jsonl）与 Codex CLI（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。
# source 由文件首行自探测：Codex 首行恒为 session_meta，Claude 永不是。
# 跨平台等价物是 MCP trans_scan（纯 Node，三平台通用）；本脚本仅作 Windows 兜底。

$CodexRoot = if ($env:TRANS_CODEX_ROOT) { $env:TRANS_CODEX_ROOT } else { Join-Path $env:USERPROFILE '.codex\sessions' }

function Cut([string]$s, [int]$n) {
    if (-not $s) { return '' }
    $s = ($s -replace '\r?\n', ' ⏎ ').Trim()
    if ($s.Length -le $n) { return $s }
    return $s.Substring(0, $n) + '…'
}

function Get-MsgText($content) {
    if ($null -eq $content) { return '' }
    if ($content -is [string]) { return $content }
    $texts = @($content | Where-Object { $_.type -eq 'text' } | ForEach-Object { $_.text })
    return ($texts -join ' ')
}

function Get-Stamp($rec) {
    try {
        if ($rec.timestamp) { return ([datetime]$rec.timestamp).ToLocalTime().ToString('MM-dd HH:mm') }
    } catch {}
    return ''
}

# ---------- Codex 适配（与 codex.mjs 语义对齐）----------

# 读首行 session_meta；非 Codex 返回 $null。
function Get-CodexMeta([string]$file) {
    try {
        $first = Get-Content -LiteralPath $file -TotalCount 1 -ErrorAction Stop
        if (-not $first) { return $null }
        $j = $first | ConvertFrom-Json -ErrorAction Stop
        if ($j.type -ne 'session_meta') { return $null }
        $p = $j.payload
        return [pscustomobject]@{
            SessionId = if ($p.session_id) { $p.session_id } elseif ($p.id) { $p.id } else { [IO.Path]::GetFileNameWithoutExtension($file) }
            Cwd       = if ($p.cwd) { $p.cwd } else { '' }
        }
    } catch { return $null }
}

function Test-CodexFile([string]$file) { return $null -ne (Get-CodexMeta $file) }

# Codex 注入进 user_message 的系统包裹标签（精确名单，不误伤用户粘的 SVG/XML）。
$CodexSysWrap = '^\s*<(project_instructions|environment_context|user_instructions|system_reminder|permissions instructions)\b'

# event_msg 流用户文本：不按长度过滤（Codex 有独立 user_message 事件，"123"/"你是谁" 都是真消息）。
function Get-CodexUserText($j) {
    if ($j.type -ne 'event_msg' -or $j.payload.type -ne 'user_message') { return '' }
    $t = "$($j.payload.message)".Trim()
    if (-not $t -or $t -match $CodexSysWrap) { return '' }
    return $t
}

function Get-CodexAgentText($j) {
    if ($j.type -ne 'event_msg' -or $j.payload.type -ne 'agent_message') { return '' }
    return "$($j.payload.message)".Trim()
}

# response_item/message 文本（content 是 input_text/output_text 块数组）。
function Get-CodexRespText($payload) {
    $c = $payload.content
    if ($null -eq $c) { return '' }
    if ($c -is [string]) { return $c }
    $texts = @($c | Where-Object { $_.type -in @('input_text', 'output_text', 'text') } | ForEach-Object { $_.text })
    return ($texts -join ' ')
}

# 发现所有 Codex rollout：{ File, SessionId, Cwd, Mtime }。
function Get-CodexSessions {
    if (-not (Test-Path $CodexRoot)) { return @() }
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($f in (Get-ChildItem $CodexRoot -Recurse -Filter 'rollout-*.jsonl' -File -ErrorAction SilentlyContinue)) {
        $meta = Get-CodexMeta $f.FullName
        if (-not $meta) { continue }
        $out.Add([pscustomobject]@{ File = $f.FullName; SessionId = $meta.SessionId; Cwd = $meta.Cwd; Mtime = $f.LastWriteTime })
    }
    return $out
}

function Get-FirstUserMsg([string]$file) {
    if (Test-CodexFile $file) {
        foreach ($line in (Get-Content -LiteralPath $file)) {
            try { $j = $line | ConvertFrom-Json } catch { continue }
            $t = Get-CodexUserText $j
            if ($t) { return (Cut $t 120) }
        }
        return '(无用户消息)'
    }
    foreach ($line in (Get-Content -LiteralPath $file -TotalCount 400)) {
        try { $j = $line | ConvertFrom-Json } catch { continue }
        if ($j.type -ne 'user' -or $j.isSidechain) { continue }
        $t = Get-MsgText $j.message.content
        if ($t -and $t -notmatch '^\s*<' -and $t.Length -gt 5) { return (Cut $t 120) }
    }
    return '(前 400 行内无真实用户消息)'
}

$projPath = if ($Project) { $Project } else { (Get-Location).Path }
$enc = ($projPath -replace '[^A-Za-z0-9]', '-')
$projDir = Join-Path $env:USERPROFILE ".claude\projects\$enc"

# ---------- 会话定位（合并两来源）----------

if (-not $Path) {
    if ($Id) {
        $found = New-Object System.Collections.Generic.List[object]
        # Claude：当前项目目录优先，再全局
        if (Test-Path $projDir) {
            foreach ($f in @(Get-ChildItem $projDir -Filter "$Id*.jsonl" -File)) {
                $found.Add([pscustomobject]@{ File = $f.FullName; Sid = $f.BaseName; Source = 'claude'; Mtime = $f.LastWriteTime })
            }
        }
        if ($found.Count -eq 0) {
            $claudeRoot = Join-Path $env:USERPROFILE '.claude\projects'
            if (Test-Path $claudeRoot) {
                foreach ($f in @(Get-ChildItem $claudeRoot -Recurse -Filter "$Id*.jsonl" -File -Depth 2)) {
                    $found.Add([pscustomobject]@{ File = $f.FullName; Sid = $f.BaseName; Source = 'claude'; Mtime = $f.LastWriteTime })
                }
            }
        }
        # Codex：按 sessionId 前缀（发现层已读回真实 id）
        foreach ($s in (Get-CodexSessions)) {
            if ($s.SessionId.StartsWith($Id) -or ([IO.Path]::GetFileName($s.File)).Contains($Id)) {
                $found.Add([pscustomobject]@{ File = $s.File; Sid = $s.SessionId; Source = 'codex'; Mtime = $s.Mtime })
            }
        }
        if ($found.Count -eq 0) { Write-Output "未找到匹配 '$Id*' 的转录（Claude/Codex 均无）"; exit 1 }
        if ($found.Count -gt 1) {
            Write-Output "匹配到 $($found.Count) 个转录，请用更长前缀或 -Path 指定："
            $found | ForEach-Object { Write-Output "  $($_.Sid) [$($_.Source)]  $($_.Mtime.ToString('MM-dd HH:mm'))" }
            exit 1
        }
        $Path = $found[0].File
    }
    else {
        # 合并两来源候选会话（按 cwd 命中的 Codex + Claude 项目目录）
        $cands = New-Object System.Collections.Generic.List[object]
        if (Test-Path $projDir) {
            foreach ($f in @(Get-ChildItem $projDir -Filter '*.jsonl' -File)) {
                $cands.Add([pscustomobject]@{ File = $f.FullName; Sid = $f.BaseName; Source = 'claude'; Mtime = $f.LastWriteTime; Size = $f.Length })
            }
        }
        foreach ($s in (Get-CodexSessions)) {
            if ($s.Cwd -eq $projPath) {
                $sz = try { (Get-Item -LiteralPath $s.File).Length } catch { 0 }
                $cands.Add([pscustomobject]@{ File = $s.File; Sid = $s.SessionId; Source = 'codex'; Mtime = $s.Mtime; Size = $sz })
            }
        }
        if ($cands.Count -eq 0) { Write-Output "该项目下无转录（Claude 目录 $projDir 与 Codex 均无匹配会话）"; exit 1 }
        $files = @($cands | Sort-Object Mtime -Descending)
        if ($List) {
            Write-Output "=== 候选会话（mtime 降序；最新的通常是当前会话本身）==="
            $n = 0
            foreach ($f in ($files | Select-Object -First 12)) {
                $n++
                $tag = if ($n -eq 1) { ' ←可能是当前会话' } else { '' }
                $src = if ($f.Source -eq 'codex') { ' [codex]' } else { '' }
                Write-Output ("{0}. {1}{2}  {3}  {4:N0}KB{5}" -f $n, $f.Sid, $src, $f.Mtime.ToString('MM-dd HH:mm'), ($f.Size / 1KB), $tag)
                Write-Output ("   首条: " + (Get-FirstUserMsg $f.File))
            }
            exit 0
        }
        $pick = if ($files.Count -ge 2) { $files[1] } else { $files[0] }
        Write-Output "（未给 ID：跳过最新的 $($files[0].Sid)（疑似当前会话），取次新）"
        $Path = $pick.File
    }
}

if (-not (Test-Path $Path)) { Write-Output "转录不存在：$Path"; exit 1 }

# ---------- source 分派 ----------

$isCodex = Test-CodexFile $Path

$item = Get-Item -LiteralPath $Path
$lines = Get-Content -LiteralPath $Path
$records = New-Object System.Collections.Generic.List[object]
$idx = 0
foreach ($line in $lines) {
    $idx++
    if (-not "$line".Trim()) { continue }
    try { $j = $line | ConvertFrom-Json } catch { continue }
    $records.Add([pscustomobject]@{ Line = $idx; Rec = $j })
}

if ($isCodex) {
    $meta = Get-CodexMeta $Path
    Write-Output "=== 会话文件（Codex）==="
    Write-Output ("{0}" -f $item.FullName)
    Write-Output ("{0} 行 / {1:N0} KB / cwd {2} / 最后写入 {3}" -f $lines.Count, ($item.Length / 1KB), $meta.Cwd, $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))

    # 用户消息脉络：event_msg 流
    $userMsgs = New-Object System.Collections.Generic.List[object]
    foreach ($r in $records) {
        $t = Get-CodexUserText $r.Rec
        if ($t) { $userMsgs.Add([pscustomobject]@{ Line = $r.Line; Stamp = (Get-Stamp $r.Rec); Text = $t }) }
    }
    Write-Output ""
    $shown = if ($MaxMsgs -gt 0 -and $userMsgs.Count -gt $MaxMsgs) { $userMsgs | Select-Object -Last $MaxMsgs } else { $userMsgs }
    $omit = $userMsgs.Count - @($shown).Count
    $omitNote = if ($omit -gt 0) { "（略去更早 $omit 条，-MaxMsgs 0 看全量）" } else { '' }
    Write-Output "=== 用户消息脉络（共 $($userMsgs.Count) 条$omitNote）==="
    foreach ($m in $shown) { Write-Output ("[{0} {1}] {2}" -f $m.Line, $m.Stamp, (Cut $m.Text 400)) }

    # 尾部概览：混合两流（event_msg 可读文本 + response_item 工具名）
    Write-Output ""
    Write-Output "=== 尾部概览（最后 $Tail 条记录）==="
    $tailRecs = if ($records.Count -gt $Tail) { $records | Select-Object -Last $Tail } else { $records }
    foreach ($r in $tailRecs) {
        $j = $r.Rec
        if ($j.type -eq 'event_msg') {
            $u = Get-CodexUserText $j
            if ($u) { Write-Output ("[{0}] USER: {1}" -f $r.Line, (Cut $u $MaxLen)); continue }
            $a = Get-CodexAgentText $j
            if ($a) { Write-Output ("[{0}] AI: {1}" -f $r.Line, (Cut $a $MaxLen)); continue }
        }
        elseif ($j.type -eq 'response_item') {
            $p = $j.payload
            switch ($p.type) {
                'function_call' { Write-Output ("[{0}] CALL {1}({2})" -f $r.Line, $p.name, (Cut $p.arguments 120)) }
                'custom_tool_call' { Write-Output ("[{0}] CALL {1}({2})" -f $r.Line, $p.name, (Cut $p.input 120)) }
                'function_call_output' { Write-Output ("[{0}] TOOL_OUT" -f $r.Line) }
                'custom_tool_call_output' { Write-Output ("[{0}] TOOL_OUT" -f $r.Line) }
            }
        }
    }

    # 断点明细锚点：最后一条真实用户消息
    $anchor = if ($Detail -gt 0) { $Detail } elseif ($userMsgs.Count -gt 0) { $userMsgs[-1].Line } else { 1 }
    $anchorNote = if ($Detail -gt 0) { '手动指定' } elseif ($userMsgs.Count -gt 0) { Cut $userMsgs[-1].Text 80 } else { '' }
    Write-Output ""
    Write-Output "=== 断点明细（锚点 [$anchor] $anchorNote）==="
    $acts = New-Object System.Collections.Generic.List[string]
    foreach ($r in $records) {
        if ($r.Line -lt $anchor) { continue }
        $j = $r.Rec
        if ($j.type -ne 'response_item') { continue }
        $p = $j.payload
        switch ($p.type) {
            'message' {
                if ($p.role -eq 'assistant') {
                    $t = Get-CodexRespText $p
                    if ($t) { $acts.Add(("[{0}] 文本: {1}" -f $r.Line, (Cut $t 600))) }
                }
            }
            'function_call' { $acts.Add(("[{0}] {1}: {2}" -f $r.Line, $p.name, (Cut $p.arguments 1200))) }
            'custom_tool_call' { $acts.Add(("[{0}] {1}: {2}" -f $r.Line, $p.name, (Cut $p.input 1200))) }
        }
    }
    if ($acts.Count -gt 100) {
        Write-Output "（动作过多，示最后 100 条；用 -Detail <行号> 换锚点）"
        $acts | Select-Object -Last 100 | ForEach-Object { Write-Output $_ }
    } else {
        $acts | ForEach-Object { Write-Output $_ }
    }

    Write-Output ""
    Write-Output "=== 下一步（对账，转录≠磁盘事实）==="
    Write-Output "1. git status --short + git diff --stat 核对工作树"
    Write-Output "2. 断点明细里每个写文件动作逐条核实是否落盘"
    Write-Output "3. 有解释不了的改动 → 停下报告，按多会话冲突处理"
    exit 0
}

# ---------- Claude 路径（原逻辑）----------

Write-Output "=== 会话文件 ==="
Write-Output ("{0}" -f $item.FullName)
Write-Output ("{0} 行 / {1:N0} KB / 最后写入 {2}" -f $lines.Count, ($item.Length / 1KB), $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))

$summaries = @($records | Where-Object { $_.Rec.type -eq 'summary' })
if ($summaries) {
    Write-Output ""
    Write-Output "=== 压缩摘要（共 $($summaries.Count) 条，示最后一条）==="
    Write-Output (Cut $summaries[-1].Rec.summary 1500)
}

$userMsgs = New-Object System.Collections.Generic.List[object]
foreach ($r in $records) {
    $j = $r.Rec
    if ($j.type -ne 'user' -or $j.isSidechain) { continue }
    $t = Get-MsgText $j.message.content
    if ($t -and $t -notmatch '^\s*<' -and $t.Length -gt 5) {
        $userMsgs.Add([pscustomobject]@{ Line = $r.Line; Stamp = (Get-Stamp $j); Text = $t })
    }
}

Write-Output ""
$shown = if ($MaxMsgs -gt 0 -and $userMsgs.Count -gt $MaxMsgs) { $userMsgs | Select-Object -Last $MaxMsgs } else { $userMsgs }
$omit = $userMsgs.Count - @($shown).Count
$omitNote = if ($omit -gt 0) { "（略去更早 $omit 条，-MaxMsgs 0 看全量）" } else { '' }
Write-Output "=== 用户消息脉络（共 $($userMsgs.Count) 条真实消息$omitNote）==="
foreach ($m in $shown) {
    Write-Output ("[{0} {1}] {2}" -f $m.Line, $m.Stamp, (Cut $m.Text 400))
}

Write-Output ""
Write-Output "=== 尾部概览（最后 $Tail 条记录）==="
$tailRecs = if ($records.Count -gt $Tail) { $records | Select-Object -Last $Tail } else { $records }
foreach ($r in $tailRecs) {
    $j = $r.Rec
    if ($j.isSidechain) { continue }
    switch ($j.type) {
        'summary' { Write-Output ("[{0}] SUMMARY: {1}" -f $r.Line, (Cut $j.summary $MaxLen)) }
        'user' {
            $t = Get-MsgText $j.message.content
            if ($t) { Write-Output ("[{0}] USER: {1}" -f $r.Line, (Cut $t $MaxLen)) }
            elseif (@($j.message.content | Where-Object { $_.type -eq 'tool_result' })) { Write-Output ("[{0}] TOOL_RESULT" -f $r.Line) }
        }
        'assistant' {
            $t = Get-MsgText $j.message.content
            $tools = @($j.message.content | Where-Object { $_.type -eq 'tool_use' } | ForEach-Object { $_.name }) -join ','
            $out = ''
            if ($t) { $out = 'AI: ' + (Cut $t $MaxLen) }
            if ($tools) { $out = if ($out) { "$out [$tools]" } else { "AI [$tools]" } }
            if ($out) { Write-Output ("[{0}] {1}" -f $r.Line, $out) }
        }
    }
}

$controlPattern = '^(\[Request interrupted|Continue from where you left off|\[Image)|^#\S+$'
$anchorMsg = $null
for ($i = $userMsgs.Count - 1; $i -ge 0; $i--) {
    if ($userMsgs[$i].Text -notmatch $controlPattern) { $anchorMsg = $userMsgs[$i]; break }
}
$anchor = if ($Detail -gt 0) { $Detail } elseif ($anchorMsg) { $anchorMsg.Line } elseif ($userMsgs.Count -gt 0) { $userMsgs[-1].Line } else { 1 }
$anchorNote = if ($Detail -gt 0) { '手动指定' } elseif ($anchorMsg) { Cut $anchorMsg.Text 80 } else { '' }
Write-Output ""
Write-Output "=== 断点明细（锚点 [$anchor] $anchorNote）==="
$acts = New-Object System.Collections.Generic.List[string]
foreach ($r in $records) {
    if ($r.Line -lt $anchor) { continue }
    $j = $r.Rec
    if ($j.type -ne 'assistant' -or $j.isSidechain) { continue }
    foreach ($b in $j.message.content) {
        if ($b.type -eq 'text') {
            $acts.Add(("[{0}] 文本: {1}" -f $r.Line, (Cut $b.text 600)))
        }
        elseif ($b.type -eq 'tool_use') {
            $inp = try { ($b.input | ConvertTo-Json -Depth 5 -Compress) } catch { '(input 序列化失败)' }
            $acts.Add(("[{0}] {1}: {2}" -f $r.Line, $b.name, (Cut $inp 1200)))
        }
    }
}
if ($acts.Count -gt 100) {
    Write-Output "（动作过多，示最后 100 条；用 -Detail <行号> 换锚点）"
    $acts | Select-Object -Last 100 | ForEach-Object { Write-Output $_ }
} else {
    $acts | ForEach-Object { Write-Output $_ }
}

Write-Output ""
Write-Output "=== 下一步（对账，转录≠磁盘事实）==="
Write-Output "1. git status --short + git diff --stat 核对工作树是否与断点明细吻合"
Write-Output "2. 断点明细里每个 Edit/Write 用 Read 或 git diff 逐条核实是否落盘"
Write-Output "3. 有解释不了的改动 → 停下报告，按多会话冲突处理"
