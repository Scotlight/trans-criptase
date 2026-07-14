#!/usr/bin/env node
// trans 端到端 smoke test：可复现、零依赖、零污染。
//
// 完全 hermetic：通过 TRANS_PROJECTS_ROOT / TRANS_INDEX_ROOT 把转录与索引
// 都指向一个临时目录，绝不触碰你真实的 ~/.claude/projects 或插件 index/。
// 只用 Node 内置模块 + 纯关键词模式（--no-embed / --exact），因此不需要任何 API key，
// 可在任意机器（Windows / macOS / Linux）上原样跑通。
//
// 用法：  node test/smoke.mjs
// 退出码：0 = 全通过；1 = 有断言失败。
//
// 它验证一条完整链路，对应评审者要的 A→B 跨会话回忆场景：
//   1. 造一条内容已知的假会话转录（= 会话 A 留下的记录）
//   2. 建索引（纯关键词，无 API）
//   3. 检索已知内容 → 断言命中（= 会话 B 成功回忆）
//   4. trans_projects 发现该项目 → 断言列出其真实路径
//   5. 清空索引 → 断言再查已查不到（= 记忆可彻底抹除）

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEMANTIC = path.join(HERE, '..', 'scripts', 'semantic.mjs')

// ── 临时沙盒：转录与索引都落在这里，跑完整体删除 ──
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'trans-smoke-'))
const PROJECTS_ROOT = path.join(SANDBOX, 'projects')
const INDEX_ROOT = path.join(SANDBOX, 'index')

// 假项目的真实 cwd（含空格 + 盘符，最贴近真实场景）与其编码目录名
const FAKE_CWD = process.platform === 'win32' ? 'D:\\smoke\\demo project' : '/smoke/demo project'
const ENC = FAKE_CWD.replace(/[^A-Za-z0-9]/g, '-')
const PROJECT_DIR = path.join(PROJECTS_ROOT, ENC)

// 已知内容：查询时用一个不常见的短语，确保命中来自我们造的转录而非偶然
const NEEDLE = 'zebrafish migration checkpoint'
const SESSION_ID = '0a1b2c3d-4e5f-6789-abcd-ef0123456789'

const ENV = { ...process.env, TRANS_PROJECTS_ROOT: PROJECTS_ROOT, TRANS_INDEX_ROOT: INDEX_ROOT }

function run(args) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [SEMANTIC, ...args], { env: ENV })
        let out = '', err = ''
        child.stdout.on('data', (d) => { out += d })
        child.stderr.on('data', (d) => { err += d })
        child.on('close', (code) => resolve({ code, out, err }))
    })
}

let failures = 0
function check(name, cond, detail = '') {
    if (cond) { console.log(`  ✓ ${name}`) }
    else { console.log(`  ✗ ${name}${detail ? '  — ' + detail : ''}`); failures++ }
}

function writeFakeTranscript() {
    fs.mkdirSync(PROJECT_DIR, { recursive: true })
    const rows = [
        { type: 'summary', summary: 'smoke test session' },
        { type: 'user', cwd: FAKE_CWD, timestamp: '2026-01-01T10:00:00Z', message: { content: `Let's design the ${NEEDLE} for the pipeline stage.` } },
        { type: 'assistant', cwd: FAKE_CWD, timestamp: '2026-01-01T10:00:05Z', message: { content: [{ type: 'text', text: `The ${NEEDLE} will gate the transition between phases.` }] } },
        { type: 'user', cwd: FAKE_CWD, timestamp: '2026-01-01T10:01:00Z', message: { content: 'Some unrelated follow-up about coffee and weather that should not match the needle.' } },
    ]
    fs.writeFileSync(path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

async function main() {
    console.log(`\ntrans smoke test  (sandbox: ${SANDBOX})\n`)

    // 1. 造假转录
    writeFakeTranscript()
    check('fake transcript created', fs.existsSync(path.join(PROJECT_DIR, `${SESSION_ID}.jsonl`)))

    // 2. 建索引（纯关键词，无 API）
    const idx = await run(['index', '--project', FAKE_CWD, '--no-embed'])
    check('index build exits 0', idx.code === 0, idx.err.trim())
    check('index reports new chunks', /新增\s*\d/.test(idx.out) || /\+\d+\s*块/.test(idx.out), idx.out.trim())

    // 3. 检索已知短语 → 命中
    const hit = await run(['query', NEEDLE, '--project', FAKE_CWD, '--exact'])
    check('query exits 0', hit.code === 0, hit.err.trim())
    check('query recalls the known needle', hit.out.includes(SESSION_ID.slice(0, 8)) && /zebrafish/i.test(hit.out), hit.out.trim())

    // 4. trans_projects 发现该项目并回读真实路径
    const proj = await run(['projects'])
    check('projects exits 0', proj.code === 0, proj.err.trim())
    check('projects lists the real cwd', proj.out.includes(FAKE_CWD), proj.out.trim())

    // 5. 清空索引 → 再查已查不到
    fs.rmSync(INDEX_ROOT, { recursive: true, force: true })
    const gone = await run(['query', NEEDLE, '--project', FAKE_CWD, '--exact'])
    // 索引清空后：要么提示无索引，要么明确无命中——总之不再吐出那条转录
    check('after wipe, needle is no longer recalled', !gone.out.includes(SESSION_ID.slice(0, 8)), gone.out.trim())

    console.log(failures === 0 ? '\nPASS — all smoke checks green\n' : `\nFAIL — ${failures} check(s) failed\n`)
}

main()
    .catch((e) => { console.error('smoke test crashed:', e); failures++ })
    .finally(() => {
        try { fs.rmSync(SANDBOX, { recursive: true, force: true }) } catch { }
        process.exit(failures === 0 ? 0 : 1)
    })
