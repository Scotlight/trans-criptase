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

function Get-FirstUserMsg([string]$file) {
    foreach ($line in (Get-Content $file -TotalCount 400)) {
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

if (-not $Path) {
    if ($Id) {
        $found = @()
        if (Test-Path $projDir) { $found = @(Get-ChildItem $projDir -Filter "$Id*.jsonl" -File) }
        if (-not $found) {
            $found = @(Get-ChildItem (Join-Path $env:USERPROFILE '.claude\projects') -Recurse -Filter "$Id*.jsonl" -File -Depth 2)
        }
        if (-not $found) { Write-Output "未找到匹配 '$Id*' 的转录（项目目录：$projDir）"; exit 1 }
        if ($found.Count -gt 1) {
            Write-Output "匹配到 $($found.Count) 个转录，请用更长前缀或 -Path 指定："
            $found | ForEach-Object { Write-Output "  $($_.FullName)  ($($_.LastWriteTime.ToString('MM-dd HH:mm')))" }
            exit 1
        }
        $Path = $found[0].FullName
    }
    else {
        if (-not (Test-Path $projDir)) { Write-Output "项目转录目录不存在：$projDir"; exit 1 }
        $files = @(Get-ChildItem $projDir -Filter '*.jsonl' -File | Sort-Object LastWriteTime -Descending)
        if (-not $files) { Write-Output "目录内没有转录：$projDir"; exit 1 }
        if ($List) {
            Write-Output "=== 候选会话（mtime 降序；最新的通常是当前会话本身）==="
            $n = 0
            foreach ($f in ($files | Select-Object -First 12)) {
                $n++
                $tag = if ($n -eq 1) { ' ←可能是当前会话' } else { '' }
                Write-Output ("{0}. {1}  {2}  {3:N0}KB{4}" -f $n, $f.BaseName, $f.LastWriteTime.ToString('MM-dd HH:mm'), ($f.Length / 1KB), $tag)
                Write-Output ("   首条: " + (Get-FirstUserMsg $f.FullName))
            }
            exit 0
        }
        $pick = if ($files.Count -ge 2) { $files[1] } else { $files[0] }
        Write-Output "（未给 ID：跳过最新的 $($files[0].BaseName)（疑似当前会话），取次新）"
        $Path = $pick.FullName
    }
}

if (-not (Test-Path $Path)) { Write-Output "转录不存在：$Path"; exit 1 }

$item = Get-Item $Path
$lines = Get-Content $Path
Write-Output "=== 会话文件 ==="
Write-Output ("{0}" -f $item.FullName)
Write-Output ("{0} 行 / {1:N0} KB / 最后写入 {2}" -f $lines.Count, ($item.Length / 1KB), $item.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))

$records = New-Object System.Collections.Generic.List[object]
$idx = 0
foreach ($line in $lines) {
    $idx++
    try { $j = $line | ConvertFrom-Json } catch { continue }
    $records.Add([pscustomobject]@{ Line = $idx; Rec = $j })
}

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
