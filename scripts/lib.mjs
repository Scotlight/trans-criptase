// trans 共享逻辑：转录解析 / 索引 / 检索。semantic.mjs(CLI) 与 mcp-server.mjs 共用。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

// SKILL_DIR 按本文件位置推导（lib.mjs 在 <SKILL_DIR>/scripts/），不写死 ~/.claude/skills/trans，
// 这样插件装到别处（marketplace / --plugin-dir / 任意目录）也能定位 config 与 index。
export const SKILL_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export const CONFIG_PATH = path.join(SKILL_DIR, 'embed-config.json')
// INDEX_ROOT / PROJECTS_ROOT 允许被环境变量覆盖：默认走真实位置，
// 但 smoke test 可指向临时目录，从而完全不碰用户的真实转录与索引（可复现、零污染）。
export const INDEX_ROOT = process.env.TRANS_INDEX_ROOT || path.join(SKILL_DIR, 'index')
export const PROJECTS_ROOT = process.env.TRANS_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects')

export function loadConfig() {
    let cfg = {}
    if (fs.existsSync(CONFIG_PATH)) {
        try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) } catch { cfg = {} }
    }
    cfg.provider = process.env.TRANS_EMBED_PROVIDER || cfg.provider || 'api'
    cfg.localEmbedder = process.env.TRANS_LOCAL_EMBEDDER || cfg.localEmbedder || ''
    cfg.localDtype = cfg.localDtype || 'fp32'
    cfg.baseUrl = process.env.TRANS_EMBED_BASE_URL || cfg.baseUrl || ''
    cfg.apiKey = process.env.TRANS_EMBED_API_KEY || cfg.apiKey || ''
    cfg.model = process.env.TRANS_EMBED_MODEL || cfg.model || 'BAAI/bge-m3'
    cfg.rerankModel = process.env.TRANS_RERANK_MODEL || cfg.rerankModel || ''
    cfg.batchSize = cfg.batchSize || 32
    cfg.maxChars = cfg.maxChars || 800
    cfg.stride = cfg.stride || 720
    cfg.autoRefresh = cfg.autoRefresh !== false
    cfg.autoRefreshMaxChunks = cfg.autoRefreshMaxChunks || 300
    return cfg
}
export let CFG = loadConfig()
export function refreshConfig() { CFG = loadConfig(); return CFG }

export const encodeProject = (p) => p.replace(/[^A-Za-z0-9]/g, '-')
export const projectTranscriptDir = (project) => path.join(PROJECTS_ROOT, encodeProject(project || process.cwd()))

const CONTROL = /^(\[Request interrupted|Continue from where you left off|\[Image)|^#\S+$/

function cut(s, n, flat = true) {
    if (!s) return ''
    s = flat ? String(s).replace(/\s+/g, ' ').trim() : String(s).trim()
    return s.length <= n ? s : s.slice(0, n) + '…'
}
const stampOf = (j) => j?.timestamp ? String(j.timestamp).slice(0, 16).replace('T', ' ') : ''

function msgText(c) {
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.filter(b => b.type === 'text').map(b => b.text).join(' ')
    return ''
}

export function extractRecord(j) {
    if (j.isSidechain) return null
    if (j.type === 'summary') return j.summary ? { role: 'summary', text: String(j.summary) } : null
    if (j.type !== 'user' && j.type !== 'assistant') return null
    const text = (msgText(j.message?.content) || '').trim()
    if (!text || text.length <= 5) return null
    if (j.type === 'user' && (/^\s*</.test(text) || CONTROL.test(text))) return null
    return { role: j.type === 'user' ? 'user' : 'ai', text }
}

// ---------- 转录读取 / 会话发现 ----------

function readRecords(file) {
    const out = []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { out.push({ line: i + 1, j: JSON.parse(lines[i]) }) } catch { }
    }
    return { records: out, totalLines: lines.length }
}

function firstUserMsg(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 400)
    for (const l of lines) {
        if (!l.trim()) continue
        let j
        try { j = JSON.parse(l) } catch { continue }
        if (j.type !== 'user' || j.isSidechain) continue
        const t = (msgText(j.message?.content) || '').trim()
        if (t && !/^\s*</.test(t) && t.length > 5) return cut(t, 120)
    }
    return '(前 400 行内无真实用户消息)'
}

// 从转录读回真实 cwd：编码目录名（非字母数字全替成 -）有损，无法反推原始路径，
// 只能从 user 记录里的 cwd 字段读回。供跨项目发现用。
function transcriptCwd(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').slice(0, 400)
    for (const l of lines) {
        if (!l.trim()) continue
        let j
        try { j = JSON.parse(l) } catch { continue }
        if (typeof j.cwd === 'string' && j.cwd) return j.cwd
    }
    return null
}

// 发现所有已知项目：真实 cwd + 最近活跃时间 + 会话数 + 是否已建索引 + 最新会话首条消息。
// 跨项目检索的第一步：AI 先调这个拿到目标项目的真实路径，再把路径传给 trans_search 的 project 参数，
// 定向搜单个项目——而不是 allProjects 把每个项目的索引全量轮询一遍（项目一多就废）。
export function projectsLines({ limit = 40, query = '' } = {}) {
    if (!fs.existsSync(PROJECTS_ROOT)) return ['尚无任何项目转录目录']
    const rows = []
    for (const d of fs.readdirSync(PROJECTS_ROOT)) {
        const pd = path.join(PROJECTS_ROOT, d)
        let st
        try { st = fs.statSync(pd) } catch { continue }
        if (!st.isDirectory()) continue
        const files = fs.readdirSync(pd).filter(f => f.endsWith('.jsonl')).map(f => path.join(pd, f))
        if (!files.length) continue
        const newest = files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)[0]
        rows.push({
            enc: d,
            cwd: transcriptCwd(newest.f) || `(未知路径，编码名: ${d})`,
            sessions: files.length,
            mtime: newest.m,
            preview: firstUserMsg(newest.f),
            indexed: fs.existsSync(indexPaths(d).state),
        })
    }
    let filtered = rows
    if (query && query.trim()) {
        const q = query.trim().toLowerCase()
        const hit = rows.filter(r => r.cwd.toLowerCase().includes(q) || r.preview.toLowerCase().includes(q))
        if (hit.length) filtered = hit  // 有命中才收窄；无命中退回全量，避免 AI 关键词猜错就啥都看不到
    }
    filtered.sort((a, b) => b.mtime - a.mtime)
    const out = [
        '=== 已知项目（按最近活跃降序）===',
        '跨项目检索：把下面的【路径】原样传给 trans_search / trans_scan 的 project 参数，定向搜该项目。',
        '不要用 allProjects 轮询全部——项目多时会把每个索引都跑一遍。',
        '',
    ]
    for (const r of filtered.slice(0, limit)) {
        out.push(`• ${r.cwd}`)
        out.push(`    ${r.sessions} 会话 / 最近 ${stampOf({ timestamp: new Date(r.mtime).toISOString() })} / 索引${r.indexed ? '已建' : '未建'}`)
        out.push(`    最新首条: ${r.preview}`)
    }
    if (filtered.length > limit) out.push('', `（共 ${filtered.length} 个，只列前 ${limit}；用 query 收窄或调大 limit）`)
    return out
}

function sessionFiles(project) {
    const dir = projectTranscriptDir(project)
    if (!fs.existsSync(dir)) throw new Error(`项目转录目录不存在：${dir}`)
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f))
        .map(f => ({ f, st: fs.statSync(f) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    if (!files.length) throw new Error(`目录内没有转录：${dir}`)
    return files
}

export function listLines({ project, limit = 12 } = {}) {
    const files = sessionFiles(project).slice(0, limit)
    const out = ['=== 候选会话（mtime 降序；最新的通常是当前会话本身）===']
    files.forEach((e, i) => {
        const tag = i === 0 ? ' ←可能是当前会话' : ''
        out.push(`${i + 1}. ${path.basename(e.f, '.jsonl')}  ${stampOf({ timestamp: e.st.mtime.toISOString() })}  ${(e.st.size / 1024).toFixed(0)}KB${tag}`)
        out.push('   首条: ' + firstUserMsg(e.f))
    })
    return out
}

export function resolveTranscript({ id, path: p, project } = {}) {
    if (p) {
        if (!fs.existsSync(p)) throw new Error(`转录不存在：${p}`)
        return { file: p, note: '' }
    }
    if (id) {
        const dir = projectTranscriptDir(project)
        let found = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.startsWith(id) && f.endsWith('.jsonl')).map(f => path.join(dir, f)) : []
        if (!found.length && fs.existsSync(PROJECTS_ROOT)) {
            for (const d of fs.readdirSync(PROJECTS_ROOT)) {
                const pd = path.join(PROJECTS_ROOT, d)
                if (!fs.statSync(pd).isDirectory()) continue
                for (const f of fs.readdirSync(pd)) {
                    if (f.startsWith(id) && f.endsWith('.jsonl')) found.push(path.join(pd, f))
                }
            }
        }
        if (!found.length) throw new Error(`未找到匹配 '${id}*' 的转录`)
        if (found.length > 1) throw new Error(`匹配到 ${found.length} 个转录，请用更长前缀：\n` + found.join('\n'))
        return { file: found[0], note: '' }
    }
    const files = sessionFiles(project)
    const pick = files.length >= 2 ? files[1] : files[0]
    return { file: pick.f, note: `（未给 ID：跳过最新的 ${path.basename(files[0].f, '.jsonl')}（疑似当前会话），取次新）` }
}

function realUserMsgs(records) {
    const out = []
    for (const r of records) {
        const j = r.j
        if (j.type !== 'user' || j.isSidechain) continue
        const t = (msgText(j.message?.content) || '').trim()
        if (t && !/^\s*</.test(t) && t.length > 5) out.push({ line: r.line, stamp: stampOf(j), text: t })
    }
    return out
}

export function scanLines({ id, path: p, project, tail = 60, maxMsgs = 60, detailLine = 0 } = {}) {
    const { file, note } = resolveTranscript({ id, path: p, project })
    const st = fs.statSync(file)
    const { records, totalLines } = readRecords(file)
    const out = []
    if (note) out.push(note)
    out.push('=== 会话文件 ===', file,
        `${totalLines} 行 / ${(st.size / 1024).toFixed(0)} KB / 最后写入 ${stampOf({ timestamp: st.mtime.toISOString() })}`)

    const summaries = records.filter(r => r.j.type === 'summary')
    if (summaries.length) {
        out.push('', `=== 压缩摘要（共 ${summaries.length} 条，示最后一条）===`, cut(summaries.at(-1).j.summary, 1500))
    }

    const userMsgs = realUserMsgs(records)
    const shown = maxMsgs > 0 && userMsgs.length > maxMsgs ? userMsgs.slice(-maxMsgs) : userMsgs
    const omit = userMsgs.length - shown.length
    out.push('', `=== 用户消息脉络（共 ${userMsgs.length} 条真实消息${omit > 0 ? `，略去更早 ${omit} 条` : ''}）===`)
    for (const m of shown) out.push(`[${m.line}${m.stamp ? ' ' + m.stamp : ''}] ${cut(m.text, 400)}`)

    out.push('', `=== 尾部概览（最后 ${tail} 条记录）===`)
    for (const r of records.slice(-tail)) {
        const j = r.j
        if (j.isSidechain) continue
        if (j.type === 'summary') out.push(`[${r.line}] SUMMARY: ${cut(j.summary, 300)}`)
        else if (j.type === 'user') {
            const t = msgText(j.message?.content)
            if (t) out.push(`[${r.line}] USER: ${cut(t, 300)}`)
            else if (Array.isArray(j.message?.content) && j.message.content.some(b => b.type === 'tool_result')) out.push(`[${r.line}] TOOL_RESULT`)
        } else if (j.type === 'assistant') {
            const t = msgText(j.message?.content)
            const tools = Array.isArray(j.message?.content) ? j.message.content.filter(b => b.type === 'tool_use').map(b => b.name).join(',') : ''
            let s = t ? 'AI: ' + cut(t, 300) : ''
            if (tools) s = s ? `${s} [${tools}]` : `AI [${tools}]`
            if (s) out.push(`[${r.line}] ${s}`)
        }
    }

    let anchorMsg = null
    for (let i = userMsgs.length - 1; i >= 0; i--) {
        if (!CONTROL.test(userMsgs[i].text)) { anchorMsg = userMsgs[i]; break }
    }
    const anchor = detailLine > 0 ? detailLine : (anchorMsg?.line ?? userMsgs.at(-1)?.line ?? 1)
    out.push('', `=== 断点明细（锚点 [${anchor}] ${detailLine > 0 ? '手动指定' : anchorMsg ? cut(anchorMsg.text, 80) : ''}）===`)
    const acts = []
    for (const r of records) {
        if (r.line < anchor || r.j.type !== 'assistant' || r.j.isSidechain) continue
        for (const b of r.j.message?.content ?? []) {
            if (b.type === 'text') acts.push(`[${r.line}] 文本: ${cut(b.text, 600)}`)
            else if (b.type === 'tool_use') {
                let inp
                try { inp = JSON.stringify(b.input) } catch { inp = '(input 序列化失败)' }
                acts.push(`[${r.line}] ${b.name}: ${cut(inp, 1200)}`)
            }
        }
    }
    if (acts.length > 100) out.push(`（动作过多，示最后 100 条；detailLine 可换锚点）`, ...acts.slice(-100))
    else out.push(...acts)

    out.push('', '=== 下一步（对账，转录≠磁盘事实）===',
        '1. git status --short + git diff --stat 核对工作树是否与断点明细吻合',
        '2. 断点明细里每个 Edit/Write 用 Read 或 git diff 逐条核实是否落盘',
        '3. 有解释不了的改动 → 停下报告，按多会话冲突处理')
    return out
}

export function expandLines({ sessionId, line, before = 6, after = 14, project } = {}) {
    if (!sessionId || !line) throw new Error('需要 sessionId 和 line')
    const { file } = resolveTranscript({ id: sessionId, project })
    const { records } = readRecords(file)
    const out = [`=== ${path.basename(file, '.jsonl').slice(0, 8)} 行 ${line} 前后上下文（-${before}/+${after}）===`]
    for (const r of records) {
        if (r.line < line - before || r.line > line + after) continue
        const j = r.j
        const mark = r.line === line ? ' ◀◀' : ''
        if (j.type === 'summary') { out.push(`[${r.line}] SUMMARY: ${cut(j.summary, 800)}${mark}`); continue }
        if (j.type !== 'user' && j.type !== 'assistant') continue
        const who = j.type === 'user' ? 'USER' : 'AI'
        const c = j.message?.content
        if (typeof c === 'string') { out.push(`[${r.line}${stampOf(j) ? ' ' + stampOf(j) : ''}] ${who}: ${cut(c, 1200, false)}${mark}`); continue }
        for (const b of c ?? []) {
            if (b.type === 'text') out.push(`[${r.line}${stampOf(j) ? ' ' + stampOf(j) : ''}] ${who}: ${cut(b.text, 1200, false)}${mark}`)
            else if (b.type === 'tool_use') {
                let inp
                try { inp = JSON.stringify(b.input) } catch { inp = '(?)' }
                out.push(`[${r.line}] ${who} ${b.name}: ${cut(inp, 800)}${mark}`)
            } else if (b.type === 'tool_result') {
                out.push(`[${r.line}] TOOL_RESULT: ${cut(msgText(b.content) || (typeof b.content === 'string' ? b.content : ''), 200)}${mark}`)
            }
        }
    }
    return out
}

// ---------- 索引 ----------

function indexPaths(enc) {
    const iDir = path.join(INDEX_ROOT, enc)
    return { iDir, state: path.join(iDir, 'state.json'), meta: path.join(iDir, 'meta.jsonl'), vec: path.join(iDir, 'vec.bin') }
}

export function chunkText(text, maxChars, stride) {
    const t = text.replace(/\s+/g, ' ').trim()
    if (t.length <= maxChars) return [t]
    const out = []
    for (let s = 0; s < t.length && out.length < 8; s += stride) out.push(t.slice(s, s + maxChars))
    return out
}

function normalize(v) {
    let s = 0
    for (const x of v) s += x * x
    s = Math.sqrt(s) || 1
    for (let i = 0; i < v.length; i++) v[i] /= s
    return v
}

let localEmbed = null

export async function embedBatch(texts, isQuery = false) {
    if (CFG.provider === 'local') {
        let emb = CFG.localEmbedder
        if (emb && !path.isAbsolute(emb)) emb = path.join(SKILL_DIR, emb)
        if (!emb || !fs.existsSync(emb)) {
            throw new Error(`provider=local 但 localEmbedder 无效：${CFG.localEmbedder || '(未填)'}（embed-config.json）`)
        }
        if (!localEmbed) {
            localEmbed = (await import(pathToFileURL(emb).href)).embed
        }
        return localEmbed(texts, { model: CFG.model, dtype: CFG.localDtype, isQuery })
    }
    if (!CFG.baseUrl || !CFG.apiKey) {
        throw new Error(`缺 API 配置：请填 ${CONFIG_PATH}（baseUrl 含 /v1、apiKey、model；或 provider 设 "local" 走本地模型）`)
    }
    const url = CFG.baseUrl.replace(/\/+$/, '') + '/embeddings'
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { Authorization: `Bearer ${CFG.apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: CFG.model, input: texts }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
            const j = await res.json()
            if (!j.data?.length) throw new Error('响应无 data: ' + JSON.stringify(j).slice(0, 300))
            return j.data.sort((a, b) => a.index - b.index).map(d => d.embedding)
        } catch (e) {
            if (attempt >= 3) throw e
            await new Promise(r => setTimeout(r, attempt * 4000))
        }
    }
}

function extractFileChunks(file, fromLine) {
    const sid = path.basename(file, '.jsonl')
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const chunks = []
    for (let li = fromLine; li < lines.length; li++) {
        if (!lines[li].trim()) continue
        let j
        try { j = JSON.parse(lines[li]) } catch { continue }
        const r = extractRecord(j)
        if (!r) continue
        chunkText(r.text, CFG.maxChars, CFG.stride).forEach((p, k) =>
            chunks.push({ sid, line: li + 1, role: r.role, ts: stampOf(j), part: k, text: p }))
    }
    return { chunks, totalLines: lines.length }
}

export async function buildIndexLines(transcriptDir, opts = {}) {
    const out = []
    const enc = path.basename(transcriptDir)
    const P = indexPaths(enc)
    fs.mkdirSync(P.iDir, { recursive: true })
    const mode = opts.noEmbed ? 'kw' : 'vec'
    let state = fs.existsSync(P.state) ? JSON.parse(fs.readFileSync(P.state, 'utf8')) : { model: CFG.model, dims: 0, mode, files: {} }
    if (opts.force || (state.model && state.model !== CFG.model) || (state.mode && state.mode !== mode)) {
        if (state.model && state.model !== CFG.model) out.push(`${enc}: 模型从 ${state.model} 换成 ${CFG.model}，全量重建`)
        else if (state.mode && state.mode !== mode) out.push(`${enc}: 索引模式 ${state.mode} → ${mode}，全量重建`)
        state = { model: CFG.model, dims: 0, mode, files: {} }
        fs.rmSync(P.meta, { force: true })
        fs.rmSync(P.vec, { force: true })
    }
    state.mode = mode
    let files = fs.readdirSync(transcriptDir).filter(f => f.endsWith('.jsonl')).map(f => path.join(transcriptDir, f))
    if (opts.skipLatest && files.length > 1) {
        const byMtime = files.map(f => ({ f, m: fs.statSync(f).mtimeMs })).sort((a, b) => b.m - a.m)
        files = byMtime.slice(1).map(e => e.f)  // 跳过 mtime 最新者（当前活跃会话，交给 SessionEnd hook/显式 index）
    }
    let totalNew = 0
    let budgetHit = false
    for (const f of files) {
        if (opts.maxChunks && !opts.noEmbed && !opts.dry && totalNew >= opts.maxChunks) { budgetHit = true; break }
        const sid = path.basename(f, '.jsonl')
        const st = fs.statSync(f)
        const prev = state.files[sid]
        let from = 0
        if (prev) {
            if (prev.mtimeMs === st.mtimeMs && prev.lines != null) continue
            const curLines = fs.readFileSync(f, 'utf8').split('\n').length
            if (curLines < prev.lines) {
                out.push(`! ${sid.slice(0, 8)} 行数变少(${prev.lines}→${curLines})，跳过；如需重建用 force`)
                continue
            }
            from = prev.lines
        }
        const { chunks, totalLines } = extractFileChunks(f, from)
        if (opts.dry) {
            if (chunks.length) out.push(`  [dry] ${sid.slice(0, 8)}: +${chunks.length} 块`)
            totalNew += chunks.length
            continue
        }
        if (chunks.length && opts.noEmbed) {
            const metaFd = fs.openSync(P.meta, 'a')
            try {
                for (const c of chunks) fs.writeSync(metaFd, JSON.stringify(c) + '\n')
            } finally { fs.closeSync(metaFd) }
        } else if (chunks.length) {
            const vecFd = fs.openSync(P.vec, 'a')
            const metaFd = fs.openSync(P.meta, 'a')
            try {
                for (let i = 0; i < chunks.length; i += CFG.batchSize) {
                    const batch = chunks.slice(i, i + CFG.batchSize)
                    const vecs = await embedBatch(batch.map(c => c.text))
                    if (!state.dims) state.dims = vecs[0].length
                    for (let k = 0; k < batch.length; k++) {
                        const v = normalize(Float32Array.from(vecs[k]))
                        fs.writeSync(vecFd, Buffer.from(v.buffer, v.byteOffset, v.byteLength))
                        fs.writeSync(metaFd, JSON.stringify(batch[k]) + '\n')
                    }
                }
            } finally {
                fs.closeSync(vecFd)
                fs.closeSync(metaFd)
            }
        }
        state.files[sid] = { lines: totalLines, mtimeMs: st.mtimeMs }
        fs.writeFileSync(P.state, JSON.stringify(state))
        totalNew += chunks.length
        if (chunks.length) out.push(`  ${sid.slice(0, 8)}: +${chunks.length} 块`)
    }
    const tailNote = opts.noEmbed && !opts.dry ? '（纯关键词索引，查询走 exact；填好 key 后 force 重建升级混合）' : ''
    if (budgetHit) out.push(`  预算已满(${opts.maxChunks}块)，剩余会话本次未索引（下次查询或 SessionEnd 后台会继续补）`)
    out.push(opts.dry ? `[dry] ${enc}: 共将新增 ${totalNew} 块（未调 API）` : `${enc}: 新增 ${totalNew} 块，索引就绪${tailNote}`)
    return out
}

export async function indexCommand(opts = {}) {
    const dirs = opts.all
        ? fs.readdirSync(PROJECTS_ROOT).map(d => path.join(PROJECTS_ROOT, d)).filter(d => fs.statSync(d).isDirectory())
        : [projectTranscriptDir(opts.project)]
    const out = []
    for (const d of dirs) {
        if (!fs.existsSync(d)) { out.push(`目录不存在: ${d}`); continue }
        out.push(...await buildIndexLines(d, opts))
    }
    return out
}

export async function autoRefreshIndex(project) {
    if (!CFG.autoRefresh) return []
    const dir = projectTranscriptDir(project)
    if (!fs.existsSync(dir)) return []
    const P = indexPaths(path.basename(dir))
    const state = fs.existsSync(P.state) ? JSON.parse(fs.readFileSync(P.state, 'utf8')) : null
    // 首次（无索引）：只建关键词让 exact 立即可用，向量首建留给显式 trans_index / SessionEnd hook（避免查询路径全量 embed 卡死）
    // 已有索引：沿用其模式增量；跳过当前活跃会话；embed 有预算上限
    const noEmbed = state ? state.mode === 'kw' : true
    const out = await buildIndexLines(dir, { noEmbed, skipLatest: true, maxChunks: CFG.autoRefreshMaxChunks })
    if (!state) out.push('（首次仅建关键词索引：语义/混合检索请先跑一次 trans_index 建立向量）')
    return out
}

// 后台增量索引（detached，供 SessionEnd hook 用）：只维护已建过索引的项目，不给新项目主动建
export function spawnBackgroundIndex(project) {
    const enc = encodeProject(project || process.cwd())
    if (!fs.existsSync(indexPaths(enc).state)) return false
    const semantic = path.join(SKILL_DIR, 'scripts', 'semantic.mjs')
    const child = spawn(process.execPath, [semantic, 'index', '--project', project || process.cwd()], {
        detached: true, stdio: 'ignore', windowsHide: true,
    })
    child.unref()
    return true
}

function loadIndex(enc) {
    const P = indexPaths(enc)
    if (!fs.existsSync(P.state) || !fs.existsSync(P.meta)) return null
    const state = JSON.parse(fs.readFileSync(P.state, 'utf8'))
    const metas = fs.readFileSync(P.meta, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
    let fa = null
    let n = metas.length
    if (state.dims && fs.existsSync(P.vec)) {
        const raw = fs.readFileSync(P.vec)
        const ab = new ArrayBuffer(raw.length)
        Buffer.from(ab).set(raw)
        fa = new Float32Array(ab)
        n = Math.min(Math.floor(fa.length / state.dims), metas.length)
    }
    return { enc, state, fa, metas, n }
}

export function keywordScores(text, indexes) {
    const q = text.toLowerCase().trim()
    const terms = q.split(/\s+/).filter(t => t.length >= 2)
    const scored = []
    for (const ix of indexes) {
        for (let i = 0; i < ix.n; i++) {
            const t = ix.metas[i].text.toLowerCase()
            let s = 0
            if (q.length >= 2 && t.includes(q)) s += 3
            if (terms.length) {
                let hits = 0
                for (const term of terms) if (t.includes(term)) hits++
                s += 2 * hits / terms.length
            }
            if (s > 0) scored.push({ kw: s, ix, i })
        }
    }
    scored.sort((a, b) => b.kw - a.kw)
    return scored
}

export function rrfFuse(vecList, kwList, K = 60) {
    const keyOf = h => h.ix.enc + ':' + h.i
    const map = new Map()
    vecList.forEach((h, r) => map.set(keyOf(h), { h, s: 1 / (K + r + 1) }))
    kwList.forEach((h, r) => {
        const k = keyOf(h)
        const add = 1 / (K + r + 1)
        const e = map.get(k)
        if (e) e.s += add
        else map.set(k, { h, s: add })
    })
    return [...map.values()].sort((a, b) => b.s - a.s).map(e => ({ ix: e.h.ix, i: e.h.i, score: e.s }))
}

async function rerankHits(queryText, hits, topN) {
    const url = CFG.baseUrl.replace(/\/+$/, '') + '/rerank'
    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${CFG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: CFG.rerankModel, query: queryText, documents: hits.map(h => h.meta.text), top_n: topN }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const j = await res.json()
    const results = j.results || j.data
    if (!results?.length) throw new Error('rerank 响应无 results')
    return results.map(r => ({ ...hits[r.index], score: r.relevance_score ?? r.score }))
}

export async function queryLines(text, opts = {}) {
    const out = []
    const top = opts.top || 8
    const encs = opts.all
        ? fs.existsSync(INDEX_ROOT) ? fs.readdirSync(INDEX_ROOT) : []
        : [encodeProject(opts.project || process.cwd())]
    const indexes = encs.map(loadIndex).filter(Boolean)
    if (!indexes.length) return ['没有可用索引，先建索引（无 key 可建纯关键词索引 noEmbed/--no-embed）']
    const mode = opts.exact ? 'exact' : opts.semantic ? 'semantic' : 'hybrid'
    let vecList = []
    let kwList = []
    if (mode !== 'exact') {
        const vecIndexes = indexes.filter(ix => ix.fa)
        for (const ix of vecIndexes) {
            if (ix.state.model !== CFG.model) out.push(`! ${ix.enc} 索引模型 ${ix.state.model} ≠ 当前配置 ${CFG.model}，建议 force 重建`)
        }
        if (!vecIndexes.length) {
            if (mode === 'semantic') return [...out, '索引没有向量（纯关键词索引），填好 key 后 force 重建']
            out.push('(索引无向量，本次纯关键词)')
        } else {
            try {
                const qv = normalize(Float32Array.from((await embedBatch([text], true))[0]))
                const hits = []
                for (const ix of vecIndexes) {
                    const dims = ix.state.dims
                    if (dims !== qv.length) continue
                    for (let i = 0; i < ix.n; i++) {
                        let s = 0
                        const off = i * dims
                        for (let d = 0; d < dims; d++) s += ix.fa[off + d] * qv[d]
                        hits.push({ score: s, ix, i })
                    }
                }
                hits.sort((a, b) => b.score - a.score)
                vecList = hits.slice(0, 200)
            } catch (e) {
                if (mode === 'semantic') throw e
                out.push(`(向量腿不可用，降级纯关键词: ${String(e.message).slice(0, 120)})`)
            }
        }
    }
    if (mode !== 'semantic') kwList = keywordScores(text, indexes).slice(0, 200)
    let ranked
    if (vecList.length && kwList.length) ranked = rrfFuse(vecList, kwList)
    else if (vecList.length) ranked = vecList
    else ranked = kwList.map(h => ({ ix: h.ix, i: h.i, score: h.kw }))
    if (!ranked.length) return [...out, '无命中']
    const pool = ranked.slice(0, opts.rerank && CFG.rerankModel ? Math.max(top * 4, 24) : top)
    let picked = pool.map(h => ({ ...h, meta: h.ix.metas[h.i] }))
    const legLabel = vecList.length && kwList.length ? '混合 RRF' : vecList.length ? '纯向量' : '纯关键词'
    if (opts.rerank && CFG.rerankModel) {
        try {
            picked = await rerankHits(text, picked, top)
            out.push(`(${legLabel} 召回 + ${CFG.rerankModel} 精排)`)
        } catch (e) {
            out.push(`(${legLabel}；rerank 不可用已降级: ${String(e.message).slice(0, 120)})`)
            picked = picked.slice(0, top)
        }
    } else {
        picked = picked.slice(0, top)
        out.push(`(${legLabel})`)
    }
    for (const h of picked) {
        const m = h.meta
        out.push(`${h.score.toFixed(4)}  ${m.sid.slice(0, 8)}:${m.line}  [${m.role}${m.ts ? ' ' + m.ts : ''}]${m.part ? ` (段${m.part + 1})` : ''} ${cut(m.text, 180)}`)
    }
    out.push('', '→ 放大上下文: trans_expand(sessionId, line) 或 scan-transcript.ps1 -Id <前缀> -Detail <行号>')
    return out
}

export function statusLines() {
    if (!fs.existsSync(INDEX_ROOT)) return ['尚无任何索引']
    const out = []
    for (const enc of fs.readdirSync(INDEX_ROOT)) {
        const P = indexPaths(enc)
        if (!fs.existsSync(P.state)) continue
        const state = JSON.parse(fs.readFileSync(P.state, 'utf8'))
        const chunks = fs.existsSync(P.meta) ? fs.readFileSync(P.meta, 'utf8').split('\n').filter(Boolean).length : 0
        const mb = fs.existsSync(P.vec) ? (fs.statSync(P.vec).size / 1048576).toFixed(1) : '0'
        out.push(`${enc}`, `  模式 ${state.mode || 'vec'} / 模型 ${state.model} / ${state.dims} 维 / ${chunks} 块 / 向量 ${mb}MB / 覆盖 ${Object.keys(state.files).length} 个会话`)
    }
    return out
}
