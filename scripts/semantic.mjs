#!/usr/bin/env node
// trans 语义检索 CLI（逻辑在 lib.mjs，MCP 服务器共用）
// 用法：
//   node semantic.mjs index  [--project <路径>] [--all] [--dry] [--force] [--no-embed]
//   node semantic.mjs query "自然语言描述" [--top 8] [--project <路径>] [--all] [--exact|--semantic] [--rerank]
//   node semantic.mjs status
import * as lib from './lib.mjs'

function parseArgs(rest) {
    const o = { project: process.cwd(), top: 8, texts: [] }
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i]
        if (a === '--project') o.project = rest[++i]
        else if (a === '--top') o.top = parseInt(rest[++i], 10) || 8
        else if (a === '--all') o.all = true
        else if (a === '--dry') o.dry = true
        else if (a === '--force') o.force = true
        else if (a === '--rerank') o.rerank = true
        else if (a === '--exact') o.exact = true
        else if (a === '--semantic') o.semantic = true
        else if (a === '--no-embed') o.noEmbed = true
        else if (a === '--limit') o.limit = parseInt(rest[++i], 10) || 40
        else if (a === '--query') o.query = rest[++i]
        else o.texts.push(a)
    }
    return o
}

const [cmd, ...rest] = process.argv.slice(2)
const opts = parseArgs(rest)
const print = (lines) => console.log(lines.join('\n'))

try {
    if (cmd === 'index') {
        print(await lib.indexCommand(opts))
    } else if (cmd === 'query') {
        const text = opts.texts.join(' ').trim()
        if (!text) { console.log('用法: node semantic.mjs query "描述" [--top 8] [--all] [--exact|--semantic] [--rerank]'); process.exit(1) }
        print(await lib.queryLines(text, opts))
    } else if (cmd === 'status') {
        print(lib.statusLines())
    } else if (cmd === 'projects') {
        print(lib.projectsLines(opts))
    } else {
        console.log('用法:\n  node semantic.mjs index  [--project <路径>] [--all] [--dry] [--force] [--no-embed]\n  node semantic.mjs query "自然语言描述" [--top 8] [--project <路径>] [--all] [--exact|--semantic] [--rerank]\n  node semantic.mjs projects [--query <关键词>] [--limit 40]\n  node semantic.mjs status\n默认混合检索（向量+关键词 RRF 融合）；--exact 纯关键词（无需 API）；--semantic 纯向量')
    }
} catch (e) {
    console.error('出错: ' + e.message)
    process.exit(1)
}
