#!/usr/bin/env node
// trans MCP server (stdio, zero-dependency hand-written JSON-RPC): exposes transcript resume/search as MCP tools
// 注册：claude mcp add --scope user trans -- node "<本文件路径>"
import readline from 'node:readline'
import * as lib from './lib.mjs'

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

const TOOLS = [
    {
        name: 'trans_search',
        description: 'Fuzzy-search across historical Claude Code session transcripts. Call this when the user mentions an old detail not in the current context ("last time we…", "that thing we discussed before…", "which session mentioned…"). Returns score/sessionId:line/preview; after a hit use trans_expand to pull full context. Auto incremental-refreshes the current project index before searching. mode: hybrid=vector+keyword RRF fusion (default), exact=keyword substring only (no API, good for variable names/error strings), semantic=vector only (conceptual fuzzy). Rerank score <0.5 means you missed the target — rephrase using the words actually used at the time, or switch to exact mode.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search text (natural language or keywords)' },
                mode: { type: 'string', enum: ['hybrid', 'exact', 'semantic'], description: 'Default: hybrid' },
                top: { type: 'number', description: 'Number of results, default 8' },
                rerank: { type: 'boolean', description: 'Default true (auto rerank when rerankModel configured, falls back gracefully); false to skip and save one API call' },
                allProjects: { type: 'boolean', description: 'Search across all projects; default: current project only' },
                project: { type: 'string', description: 'Project path, default: current working directory' },
            },
            required: ['query'],
        },
    },
    {
        name: 'trans_scan',
        description: 'Scan a historical session transcript and produce a five-part resumption brief: session size / compacted summary / user message thread (with line numbers) / tail overview / breakpoint detail (full Edit/Write input). The core tool for resuming interrupted sessions (/trans). Omit id to auto-pick the second-newest session (newest = current session, auto-skipped). After getting the brief, you MUST reconcile with git status / working tree before continuing.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Session UUID or prefix; omit to auto-pick second-newest' },
                path: { type: 'string', description: 'Direct transcript file path' },
                project: { type: 'string', description: 'Project path, default: current working directory' },
                tail: { type: 'number', description: 'Tail overview record count, default 60' },
                maxMsgs: { type: 'number', description: 'User message thread count, default 60' },
                detailLine: { type: 'number', description: 'Breakpoint detail anchor line (default: auto-picks last task-bearing user message)' },
            },
        },
    },
    {
        name: 'trans_list',
        description: 'List candidate historical sessions for the project (mtime descending + first user message preview + size). Call this first when the user says "resume last session" but you don\'t know which one.',
        inputSchema: {
            type: 'object',
            properties: {
                project: { type: 'string', description: 'Project path, default: current working directory' },
                limit: { type: 'number', description: 'Default 12' },
            },
        },
    },
    {
        name: 'trans_expand',
        description: 'Expand context around a specific transcript position: given a sessionId + line number from trans_search / trans_scan results, returns the full records around that line (including tool calls and result summaries). This is step 2 after a search hit: "found it → now read the details."',
        inputSchema: {
            type: 'object',
            properties: {
                sessionId: { type: 'string', description: 'Session UUID or prefix' },
                line: { type: 'number', description: 'Anchor line number' },
                before: { type: 'number', description: 'Lines before anchor, default 6' },
                after: { type: 'number', description: 'Lines after anchor, default 14' },
                project: { type: 'string', description: 'Project path, default: current working directory' },
            },
            required: ['sessionId', 'line'],
        },
    },
    {
        name: 'trans_index',
        description: 'Build or rebuild the transcript search index. Not needed for daily use (trans_search auto incremental-refreshes). force=full rebuild (after changing embedding model or index corruption); noEmbed=keyword-only index (zero API cost, only supports exact queries); dry=estimate new chunk count without calling API; allProjects=index all projects.',
        inputSchema: {
            type: 'object',
            properties: {
                force: { type: 'boolean' },
                noEmbed: { type: 'boolean' },
                dry: { type: 'boolean' },
                allProjects: { type: 'boolean' },
                project: { type: 'string', description: 'Project path, default: current working directory' },
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
            notes.push(`(index auto-refresh failed, using existing index: ${String(e.message).slice(0, 120)})`)
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
    throw new Error(`unknown tool: ${name}`)
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
            send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } })
        }
    } catch (e) {
        if (isReq && method === 'tools/call') {
            send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'error: ' + e.message }], isError: true } })
        } else if (isReq) {
            send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message) } })
        }
    }
})
rl.on('close', () => process.exit(0))
