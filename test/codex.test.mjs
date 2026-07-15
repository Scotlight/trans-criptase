import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
    extractRecordsForIndex, isCodexFile, sessionIdOf, encodeProject,
} from '../scripts/codex.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 写一个迷你 rollout fixture 到临时目录，返回文件路径。跑完由调用方清理。
function writeRollout(rows) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fx-'))
    const file = path.join(dir, 'rollout-2026-07-15T00-00-00-019f0000-0000-7000-8000-000000000000.jsonl')
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    return { dir, file }
}

// 一个最小但真实的 rollout：session_meta 首行 + event_msg/response_item 双写同一内容。
function fixtureRows() {
    return [
        { timestamp: '2026-07-15T00:00:00Z', type: 'session_meta', payload: { session_id: '019f0000-abcd', cwd: 'C:\\Users\\demo', timestamp: '2026-07-15T00:00:00Z' } },
        { timestamp: '2026-07-15T00:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 't1' } },
        // 真人短消息：Claude 侧 ≤5 字会被滤，Codex 必须保留
        { timestamp: '2026-07-15T00:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: '123' } },
        // AI 回复：event_msg（索引流该吃）
        { timestamp: '2026-07-15T00:00:03Z', type: 'event_msg', payload: { type: 'agent_message', message: '这是一段足够长的助手回复内容用于测试' } },
        // 同一 AI 回复的 response_item 双写（索引流必须跳过，否则重复）
        { timestamp: '2026-07-15T00:00:03Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这是一段足够长的助手回复内容用于测试' }] } },
        // reasoning 双写：两条都不该进索引流
        { timestamp: '2026-07-15T00:00:04Z', type: 'event_msg', payload: { type: 'agent_reasoning', text: '**思考中**' } },
        { timestamp: '2026-07-15T00:00:04Z', type: 'response_item', payload: { type: 'reasoning', summary: [] } },
        // 工具调用：response_item，不进索引流
        { timestamp: '2026-07-15T00:00:05Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const x = 1', call_id: 'c1' } },
        // 系统注入包裹进 user_message：必须过滤
        { timestamp: '2026-07-15T00:00:06Z', type: 'event_msg', payload: { type: 'user_message', message: '<permissions instructions>\nyou may read files' } },
        // 又一条真人消息
        { timestamp: '2026-07-15T00:00:07Z', type: 'event_msg', payload: { type: 'user_message', message: '继续' } },
    ]
}

test('encodeProject: 与 lib 侧一致（非字母数字全替 -）', () => {
    assert.equal(encodeProject('C:\\Users\\demo'), 'C--Users-demo')
})

test('extractRecordsForIndex: 只吃 event_msg 的 user/ai，避开 response_item 双写', () => {
    const { dir, file } = writeRollout(fixtureRows())
    try {
        const { records } = extractRecordsForIndex(file)
        // 期望：user「123」+ ai 回复 + user「继续」= 3 条；response_item / reasoning / tool_call / 系统注入全不计入
        assert.equal(records.length, 3)
        assert.deepEqual(records.map(r => r.role), ['user', 'ai', 'user'])
        assert.equal(records[0].text, '123')      // 短消息不误杀
        assert.equal(records[2].text, '继续')
        // 没有任何一条来自 response_item 的重复文本
        assert.equal(records.filter(r => r.text.includes('足够长')).length, 1)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('extractRecordsForIndex: 过滤系统注入的 <permissions instructions> 包裹', () => {
    const { dir, file } = writeRollout(fixtureRows())
    try {
        const { records } = extractRecordsForIndex(file)
        assert.equal(records.some(r => r.text.includes('permissions instructions')), false)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('extractRecordsForIndex: fromLine 增量只取新增行', () => {
    const { dir, file } = writeRollout(fixtureRows())
    try {
        // 从第 8 行（0-based）起：跳过前面的 123 / ai 回复，只应剩「继续」
        const { records } = extractRecordsForIndex(file, 8)
        assert.equal(records.length, 1)
        assert.equal(records[0].text, '继续')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('isCodexFile: 首行 session_meta 判为 Codex；Claude 转录判否', () => {
    const { dir, file } = writeRollout(fixtureRows())
    try {
        assert.equal(isCodexFile(file), true)
        assert.equal(sessionIdOf(file), '019f0000-abcd')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }

    // Claude 风格转录：首行是 user，不该被判为 Codex
    const claude = writeRollout([])
    try {
        fs.writeFileSync(claude.file, JSON.stringify({ type: 'user', message: { content: '你好这是 Claude 转录' } }) + '\n')
        assert.equal(isCodexFile(claude.file), false)
    } finally { fs.rmSync(claude.dir, { recursive: true, force: true }) }
})
