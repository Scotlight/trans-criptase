#!/usr/bin/env node
// trans MCP 服务器（stdio，零依赖手写 JSON-RPC）：把转录续接/检索暴露为 MCP 工具
// 注册：claude mcp add --scope user trans -- node "<本文件路径>"
import readline from 'node:readline'
import * as lib from './lib.mjs'

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

const TOOLS = [
    {
        name: 'trans_search',
        description: '跨历史 Claude Code 会话转录做模糊检索。当用户提到一个当前上下文里没有的旧细节（"上次那个…"、"之前提过的…"、"哪个会话里说过…"）时调用。返回 分数/会话ID:行号/预览，命中后用 trans_expand 放大上下文。搜索前会自动增量刷新当前项目索引。mode: hybrid=向量+关键词RRF融合(默认), exact=纯关键词子串(无需API,适合变量名/报错串), semantic=纯向量(概念模糊查询)。精排分数 <0.5 说明没捞到正主——换一种措辞（尽量贴近当事人当时会用的词）重查一次，或改用 exact 模式抓关键词。',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: '检索文本（自然语言或关键词）' },
                mode: { type: 'string', enum: ['hybrid', 'exact', 'semantic'], description: '默认 hybrid' },
                top: { type: 'number', description: '返回条数，默认 8' },
                rerank: { type: 'boolean', description: '默认 true（配置了 rerankModel 时自动精排，失败自动降级）；false 关闭省一次 API' },
                allProjects: { type: 'boolean', description: '跨所有项目找，默认只查当前项目' },
                project: { type: 'string', description: '项目路径，默认当前工作目录' },
            },
            required: ['query'],
        },
    },
    {
        name: 'trans_scan',
        description: '扫描一个历史会话转录，输出续接情报五段：会话体量/压缩摘要/用户消息脉络(带行号)/尾部概览/断点明细(含 Edit/Write 完整 input)。恢复中断会话(/trans)的核心工具。不给 id 自动取次新会话（最新的是当前会话会跳过）。拿到情报后必须与 git status/工作树对账再续接。',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: '会话 UUID 或前缀；缺省自动取次新' },
                path: { type: 'string', description: '直接指定转录文件路径' },
                project: { type: 'string', description: '项目路径，默认当前工作目录' },
                tail: { type: 'number', description: '尾部概览记录数，默认 60' },
                maxMsgs: { type: 'number', description: '用户消息脉络条数，默认 60' },
                detailLine: { type: 'number', description: '断点明细锚点行号（默认自动取最后一条任务性用户消息）' },
            },
        },
    },
    {
        name: 'trans_list',
        description: '列出项目的历史会话候选（mtime 降序 + 首条用户消息预览 + 体量）。用户说"恢复上次会话"但不确定是哪个时先调这个。',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string', description: '项目路径，默认当前工作目录' },
                limit: { type: 'number', description: '默认 12' },
            },
        },
    },
    {
        name: 'trans_expand',
        description: '放大转录某个位置的上下文：给定 trans_search / trans_scan 结果里的 会话ID+行号，返回该行前后的完整记录（含工具调用与结果摘要）。这是"检索命中 → 看清细节"的第二步。',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: '会话 UUID 或前缀' },
                line: { type: 'number', description: '锚点行号' },
                before: { type: 'number', description: '往前几行，默认 6' },
                after: { type: 'number', description: '往后几行，默认 14' },
                project: { type: 'string', description: '项目路径，默认当前工作目录' },
            },
            required: ['sessionId', 'line'],
        },
    },
    {
        name: 'trans_index',
        description: '建/重建转录检索索引。日常不用手调（trans_search 自动增量刷新）。force=全量重建（换 embedding 模型或索引损坏后）；noEmbed=纯关键词索引（零 API 零成本，只支持 exact 查询）；dry=只估算新增块数不调 API；allProjects=索引全部项目。',
        inputSchema: {
            type: 'object',
            properties: {
                force: { type: 'boolean' },
                noEmbed: { type: 'boolean' },
                dry: { type: 'boolean' },
                allProjects: { type: 'boolean' },
                project: { type: 'string', description: '项目路径，默认当前工作目录' },
            },
        },
    },
]

async function handleCall(name, a) {
    lib.refreshConfig()
    if (name === 'trans_search') {
        const notes = []
        try {
            const idx = await lib.autoRefreshIndex(a.project)
            const added = idx.filter(l => l.includes('+')).length
            if (added) notes.push(...idx)
        } catch (e) {
            notes.push(`(索引自动刷新失败，用现有索引: ${String(e.message).slice(0, 120)})`)
        }
        const lines = await lib.queryLines(a.query, {
            top: a.top, project: a.project, all: a.allProjects,
            exact: a.mode === 'exact', semantic: a.mode === 'semantic',
            rerank: a.rerank !== false,
        })
        return [...notes, ...lines].join('\n')
    }
    if (name === 'trans_scan') return lib.scanLines(a).join('\n')
    if (name === 'trans_list') return lib.listLines(a).join('\n')
    if (name === 'trans_expand') return lib.expandLines(a).join('\n')
    if (name === 'trans_index') {
        return (await lib.indexCommand({
            force: a.force, noEmbed: a.noEmbed, dry: a.dry, all: a.allProjects, project: a.project,
        })).join('\n')
    }
    throw new Error(`未知工具: ${name}`)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', async (l) => {
    l = l.trim()
    if (!l) return
    let msg
    try { msg = JSON.parse(l) } catch { return }
    const { id, method, params } = msg
    const isReq = id !== undefined && id !== null
    try {
        if (method === 'initialize') {
            send({
                jsonrpc: '2.0', id,
                result: {
                    protocolVersion: params?.protocolVersion || '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'trans', version: '1.0.0' },
                },
            })
        } else if (typeof method === 'string' && method.startsWith('notifications/')) {
            // initialized / cancelled 等通知：无需响应
        } else if (method === 'ping') {
            send({ jsonrpc: '2.0', id, result: {} })
        } else if (method === 'tools/list') {
            send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
        } else if (method === 'tools/call') {
            const text = await handleCall(params?.name, params?.arguments || {})
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
        } else if (isReq) {
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } })
        }
    } catch (e) {
        if (isReq && method === 'tools/call') {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: '出错: ' + e.message }], isError: true } })
        } else if (isReq) {
            send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message) } })
        }
    }
})
rl.on('close', () => process.exit(0))
