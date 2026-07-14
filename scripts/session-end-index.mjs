#!/usr/bin/env node
// trans SessionEnd hook：会话结束时后台增量索引刚结束的会话（不占查询时间）
// 只维护已建过索引的项目；从未用过 trans 的项目不主动建索引。
// stdin 收到 Claude Code 的 SessionEnd JSON（含 cwd）；spawn detached 后立即退出，不阻塞会话关闭。
import { spawnBackgroundIndex } from './lib.mjs'

let raw = ''
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
    let cwd = process.cwd()
    try {
        const j = JSON.parse(raw || '{}')
        if (j.cwd) cwd = j.cwd
    } catch { }
    try { spawnBackgroundIndex(cwd) } catch { }
    process.exit(0)
})
// 无 stdin（手动跑）时兜底
setTimeout(() => { try { spawnBackgroundIndex(process.cwd()) } catch { } process.exit(0) }, 2000)
