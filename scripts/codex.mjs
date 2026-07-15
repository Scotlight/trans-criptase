// codex.mjs — Codex CLI（rollout）会话日志的来源适配器：把 Codex 的会话读成 trans 的统一记录形态。
// 被 lib.mjs 调用，与 Claude Code 转录同库混合（cwd 编码一致 → 同一个 index/<enc>/ 命名空间）。
//
// Codex 与 Claude Code 的两大结构差异（本模块负责抹平）：
//  1. 目录布局：~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl，按日期分片，与 cwd 无关。
//     项目归属只能从每个文件第一行 session_meta.payload.cwd 读回（已验证 405/405 稳定命中）。
//  2. 记录 schema：每行 {timestamp,type,payload}，且 event_msg 与 response_item 对同一内容双写。
//     - 索引流（只要 user/ai 纯文本）：走 event_msg，天然去重。
//     - scan 流（要工具调用完整 input）：走 response_item。
//
// 设计要点：source 由文件首行自探测（isCodexFile），所以 lib 侧除“发现层合并两处文件列表”外，
// scan/expand/index 都能按文件自动分派，无需把 source 参数穿过每一层。chunk 切块单点留在 lib.mjs，
// 本模块只吐原始记录（extractRecordsForIndex），避免与 lib 循环依赖。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const CODEX_ROOT = process.env.TRANS_CODEX_ROOT || path.join(os.homedir(), '.codex', 'sessions')

// ---------- 小工具（本模块自持，避免与 lib 循环依赖）----------

function cut(s, n, flat = true) {
    if (!s) return ''
    s = flat ? String(s).replace(/\s+/g, ' ').trim() : String(s).trim()
    return s.length <= n ? s : s.slice(0, n) + '…'
}
const stampOf = (ts) => ts ? String(ts).slice(0, 16).replace('T', ' ') : ''
export const encodeProject = (p) => p.replace(/[^A-Za-z0-9]/g, '-')

// ---------- 记录读取 + 双流归一化 ----------

function readAllRecords(file) {
    const out = []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { out.push({ line: i + 1, j: JSON.parse(lines[i]) }) } catch { }
    }
    return { records: out, totalLines: lines.length }
}

// Codex 注入进 user_message 的系统包裹标签（精确名单，不误伤用户粘的 SVG/XML）。
const CODEX_SYS_WRAP = /^\s*<(project_instructions|environment_context|user_instructions|system_reminder|permissions instructions)\b/i

// event_msg 流里的用户文本。
// 注意：不照搬 Claude 侧的「≤5 字符」过滤——Codex 有专门的 user_message 事件类型，
// 真人输入天然与 tool_result/系统内容分离，25% 的真实消息（"你是谁"/"继续"/"123"）都 ≤5 字，
// 按长度滤会大面积误杀。只做空过滤 + 精确系统标签过滤。
function userText(j) {
    if (j.type !== 'event_msg') return ''
    const p = j.payload
    if (p?.type !== 'user_message') return ''
    const t = (p.message || '').trim()
    if (!t || CODEX_SYS_WRAP.test(t)) return ''
    return t
}

// event_msg 流里的 AI 文本
function agentText(j) {
    if (j.type !== 'event_msg') return ''
    const p = j.payload
    if (p?.type !== 'agent_message') return ''
    return (p.message || '').trim()
}

// response_item/message 的文本内容（scan/expand 流用；content 是 input_text/output_text 块数组）
function respMessageText(payload) {
    const c = payload?.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
        return c.filter(b => b.type === 'input_text' || b.type === 'output_text' || b.type === 'text')
            .map(b => b.text).join(' ')
    }
    return ''
}

// ---------- 发现层：只读首行，构建 {file, sessionId, cwd, mtime} 轻量索引 ----------

// 判定文件是否 Codex rollout：只读首行看 type===session_meta。
// Claude 转录首行是 user/summary，永不为 session_meta，故可作为可靠的 source 探针。
export function isCodexFile(file) {
    return readMeta(file) !== null
}

// 递归收集所有 rollout 文件路径。Codex 按 YYYY/MM/DD 分片，深度固定但直接 walk 更稳。
function walkRollouts(root) {
    const out = []
    if (!fs.existsSync(root)) return out
    const stack = [root]
    while (stack.length) {
        const dir = stack.pop()
        let ents
        try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
        for (const e of ents) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) stack.push(full)
            else if (e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(full)
        }
    }
    return out
}

// 只读第一行拿 session_meta。返回 null 表示不是合法 rollout（首行不是 meta）。
// 首行含 base_instructions（整个系统提示词），大小随 Codex 版本浮动（实测约 37KB，但不保证）。
// 因此按 64KB 块循环读到真换行符，而不是赌单次固定缓冲——否则超长首行会被截断、JSON.parse 失败、
// 该会话被无声丢弃（三平台通病）。设 4MB 硬顶防病态文件把整机读爆。
function readMeta(file) {
    let fd
    try { fd = fs.openSync(file, 'r') } catch { return null }
    try {
        // 攒 Buffer、找到换行的字节位置后再一次性 UTF-8 解码——绝不按 chunk 解码，
        // 否则多字节字符（CJK 路径/内容）会在 chunk 边界被拆坏。
        const CHUNK = 65536
        const CAP = 4 * 1024 * 1024
        const buf = Buffer.alloc(CHUNK)
        const parts = []
        let pos = 0
        let nlByte = -1
        while (nlByte < 0 && pos < CAP) {
            const n = fs.readSync(fd, buf, 0, CHUNK, pos)
            if (n <= 0) break
            const slice = Buffer.from(buf.subarray(0, n))
            nlByte = slice.indexOf(0x0a)  // '\n'
            parts.push(nlByte >= 0 ? slice.subarray(0, nlByte) : slice)
            pos += n
        }
        const firstLine = Buffer.concat(parts).toString('utf8')
        const j = JSON.parse(firstLine)
        if (j.type !== 'session_meta') return null
        const p = j.payload || {}
        return { sessionId: p.session_id || p.id || path.basename(file), cwd: p.cwd || '', ts: p.timestamp || j.timestamp || '' }
    } catch {
        return null
    } finally {
        fs.closeSync(fd)
    }
}

// 全量发现：每文件一次 readMeta。缓存在进程内，重复调用不重扫。
let _discoverCache = null
export function discover({ force = false } = {}) {
    if (_discoverCache && !force) return _discoverCache
    const rows = []
    for (const file of walkRollouts(CODEX_ROOT)) {
        const meta = readMeta(file)
        if (!meta) continue
        let mtime = 0
        try { mtime = fs.statSync(file).mtimeMs } catch { }
        rows.push({ file, sessionId: meta.sessionId, cwd: meta.cwd, metaTs: meta.ts, mtime })
    }
    _discoverCache = rows
    return rows
}

// 某 cwd 下的 Codex 会话文件描述符（供 lib 发现层与 Claude 合并）。
export function filesForCwd(cwd) {
    return discover()
        .filter(r => r.cwd === cwd)
        .map(r => ({ f: r.file, sid: r.sessionId, source: 'codex', mtimeMs: r.mtime }))
}

// 按 cwd 聚合的项目行（供 lib.projectsLines 合并 Claude/Codex）。
// newestFile：该 cwd 下最近活跃的会话文件，供 lib 取 preview。
export function projectRows() {
    const byCwd = new Map()
    for (const r of discover()) {
        const key = r.cwd || '(未知 cwd)'
        const g = byCwd.get(key) || { cwd: key, enc: encodeProject(key), sessions: 0, mtime: 0, newestFile: r.file }
        g.sessions++
        if (r.mtime > g.mtime) { g.mtime = r.mtime; g.newestFile = r.file }
        byCwd.set(key, g)
    }
    return [...byCwd.values()]
}

// list 预览：首条真实用户消息。
export function firstUserMsg(file) {
    const { records } = readAllRecords(file)
    for (const r of records) {
        const t = userText(r.j)
        if (t) return cut(t, 120)
    }
    return '(无用户消息)'
}

// 按 id 前缀 / path / project 定位单个 rollout 文件。
export function resolveTranscript({ id, path: p, project } = {}) {
    if (p) {
        if (!fs.existsSync(p)) throw new Error(`Codex 转录不存在：${p}`)
        return { file: p, note: '' }
    }
    const rows = discover()
    if (id) {
        // 匹配 sessionId 前缀，或文件名含该片段（rollout-... 或裸 uuid）
        const found = rows.filter(r => r.sessionId.startsWith(id) || path.basename(r.file).includes(id))
        if (!found.length) throw new Error(`未找到匹配 '${id}*' 的 Codex 转录`)
        if (found.length > 1) {
            const exact = found.filter(r => r.sessionId.startsWith(id))
            if (exact.length === 1) return { file: exact[0].file, note: '' }
            found.sort((a, b) => b.mtime - a.mtime)
            throw new Error(`匹配到 ${found.length} 个 Codex 会话，请用更长前缀：\n` + found.map(r => r.sessionId).join('\n'))
        }
        return { file: found[0].file, note: '' }
    }
    // 无 id：取某项目（或全局）次新，跳过最新（疑似当前会话）
    let pool = project ? rows.filter(r => r.cwd === project) : rows
    if (!pool.length) throw new Error(`无 Codex 会话可选（project=${project || '全局'}）`)
    pool.sort((a, b) => b.mtime - a.mtime)
    const pick = pool.length >= 2 ? pool[1] : pool[0]
    return { file: pick.file, note: `（未给 ID：跳过最新的 ${pool[0].sessionId}（疑似当前会话），取次新）` }
}

// ---------- 索引流：只吐原始记录（切块交给 lib.chunkText 单点处理）----------
// 返回形态与 lib 侧对齐：{ records:[{line, role, text, ts}], totalLines }，sid 由调用方（lib）统一注入。
export function extractRecordsForIndex(file, fromLine = 0) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const records = []
    for (let li = fromLine; li < lines.length; li++) {
        if (!lines[li].trim()) continue
        let j
        try { j = JSON.parse(lines[li]) } catch { continue }
        const u = userText(j)
        if (u) { records.push({ line: li + 1, role: 'user', text: u, ts: j.timestamp }); continue }
        const a = agentText(j)
        if (a) records.push({ line: li + 1, role: 'ai', text: a, ts: j.timestamp })
    }
    return { records, totalLines: lines.length }
}

// 会话真实 sessionId（供 lib 用作 state.files / chunk meta 的 key）。
export function sessionIdOf(file) {
    return readMeta(file)?.sessionId || path.basename(file, '.jsonl')
}

// ---------- scan 流：走 response_item，拿工具调用完整 input，对齐 Claude 侧断点明细 ----------

export function scanLines({ id, path: p, project, tail = 60, maxMsgs = 60, detailLine = 0 } = {}) {
    const { file, note } = resolveTranscript({ id, path: p, project })
    const st = fs.statSync(file)
    const meta = readMeta(file)
    const { records, totalLines } = readAllRecords(file)
    const out = []
    if (note) out.push(note)
    out.push('=== 会话文件（Codex）===', file,
        `${totalLines} 行 / ${(st.size / 1024).toFixed(0)} KB / cwd ${meta?.cwd || '?'} / 最后写入 ${stampOf(st.mtime.toISOString())}`)

    // 用户消息脉络：event_msg 流
    const userMsgs = []
    for (const r of records) {
        const t = userText(r.j)
        if (t) userMsgs.push({ line: r.line, ts: r.j.timestamp, text: t })
    }
    const shown = maxMsgs > 0 && userMsgs.length > maxMsgs ? userMsgs.slice(-maxMsgs) : userMsgs
    const omit = userMsgs.length - shown.length
    out.push('', `=== 用户消息脉络（共 ${userMsgs.length} 条${omit > 0 ? `，略去更早 ${omit} 条` : ''}）===`)
    for (const m of shown) out.push(`[${m.line}${m.ts ? ' ' + stampOf(m.ts) : ''}] ${cut(m.text, 400)}`)

    // 尾部概览：混合两流（event_msg 可读文本 + response_item 工具名）
    out.push('', `=== 尾部概览（最后 ${tail} 条记录）===`)
    for (const r of records.slice(-tail)) {
        const j = r.j
        if (j.type === 'event_msg') {
            const u = userText(j); if (u) { out.push(`[${r.line}] USER: ${cut(u, 300)}`); continue }
            const a = agentText(j); if (a) { out.push(`[${r.line}] AI: ${cut(a, 300)}`); continue }
        } else if (j.type === 'response_item') {
            const p2 = j.payload
            if (p2?.type === 'function_call') out.push(`[${r.line}] CALL ${p2.name}(${cut(p2.arguments, 120)})`)
            else if (p2?.type === 'custom_tool_call') out.push(`[${r.line}] CALL ${p2.name}(${cut(p2.input, 120)})`)
            else if (p2?.type === 'function_call_output' || p2?.type === 'custom_tool_call_output') out.push(`[${r.line}] TOOL_OUT`)
        }
    }

    // 断点明细锚点：最后一条真实用户消息
    const anchor = detailLine > 0 ? detailLine : (userMsgs.at(-1)?.line ?? 1)
    const anchorTxt = detailLine > 0 ? '手动指定' : cut(userMsgs.at(-1)?.text || '', 80)
    out.push('', `=== 断点明细（锚点 [${anchor}] ${anchorTxt}）===`)
    const acts = []
    for (const r of records) {
        if (r.line < anchor || r.j.type !== 'response_item') continue
        const p2 = r.j.payload
        if (p2?.type === 'message' && p2.role === 'assistant') {
            const t = respMessageText(p2)
            if (t) acts.push(`[${r.line}] 文本: ${cut(t, 600)}`)
        } else if (p2?.type === 'function_call') {
            acts.push(`[${r.line}] ${p2.name}: ${cut(p2.arguments, 1200)}`)
        } else if (p2?.type === 'custom_tool_call') {
            acts.push(`[${r.line}] ${p2.name}: ${cut(p2.input, 1200)}`)
        }
    }
    if (acts.length > 100) out.push('（动作过多，示最后 100 条；detailLine 可换锚点）', ...acts.slice(-100))
    else out.push(...acts)

    out.push('', '=== 下一步（对账，转录≠磁盘事实）===',
        '1. git status --short + git diff --stat 核对工作树',
        '2. 断点明细里每个写文件动作逐条核实是否落盘',
        '3. 有解释不了的改动 → 停下报告')
    return out
}

// ---------- expand 流：检索命中后按 sessionId:line 放大上下文 ----------

export function expandLines({ sessionId, line, before = 6, after = 14, project, path: p } = {}) {
    if (!line || (!sessionId && !p)) throw new Error('需要 line，且 sessionId 与 path 至少给一个')
    // lib 可能已统一 resolve 出文件，直接传 path 省去二次发现；否则按 sessionId 自行定位。
    const { file } = p ? { file: p } : resolveTranscript({ id: sessionId, project })
    const { records } = readAllRecords(file)
    const out = [`=== ${path.basename(file)} 行 ${line} 前后上下文（-${before}/+${after}，Codex）===`]
    for (const r of records) {
        if (r.line < line - before || r.line > line + after) continue
        const j = r.j
        const mark = r.line === line ? ' ◀◀' : ''
        if (j.type === 'event_msg') {
            const u = userText(j); if (u) { out.push(`[${r.line}${j.timestamp ? ' ' + stampOf(j.timestamp) : ''}] USER: ${cut(u, 1200, false)}${mark}`); continue }
            const a = agentText(j); if (a) { out.push(`[${r.line}${j.timestamp ? ' ' + stampOf(j.timestamp) : ''}] AI: ${cut(a, 1200, false)}${mark}`); continue }
        } else if (j.type === 'response_item') {
            const p2 = j.payload
            if (p2?.type === 'message') {
                const t = respMessageText(p2)
                if (t) out.push(`[${r.line}] ${(p2.role || 'msg').toUpperCase()}: ${cut(t, 1200, false)}${mark}`)
            } else if (p2?.type === 'function_call') out.push(`[${r.line}] CALL ${p2.name}: ${cut(p2.arguments, 800)}${mark}`)
            else if (p2?.type === 'custom_tool_call') out.push(`[${r.line}] CALL ${p2.name}: ${cut(p2.input, 800)}${mark}`)
            else if (p2?.type === 'function_call_output') out.push(`[${r.line}] TOOL_OUT: ${cut(typeof p2.output === 'string' ? p2.output : JSON.stringify(p2.output), 200)}${mark}`)
            else if (p2?.type === 'custom_tool_call_output') out.push(`[${r.line}] TOOL_OUT: ${cut(typeof p2.output === 'string' ? p2.output : JSON.stringify(p2.output), 200)}${mark}`)
        }
    }
    return out
}
