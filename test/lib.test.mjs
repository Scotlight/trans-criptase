import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractRecord, chunkText, rrfFuse, keywordScores, encodeProject } from '../scripts/lib.mjs'

test('encodeProject: 非字母数字全部替换为 -', () => {
    assert.equal(encodeProject('D:\\0010\\.A_project\\epub reader'), 'D--0010--A-project-epub-reader')
    assert.equal(encodeProject('/home/user/my proj'), '-home-user-my-proj')
})

test('extractRecord: 提取真实用户消息', () => {
    assert.deepEqual(
        extractRecord({ type: 'user', message: { content: '这是一个足够长的问题' } }),
        { role: 'user', text: '这是一个足够长的问题' },
    )
})

test('extractRecord: 过滤 sidechain 与控制噪音', () => {
    assert.equal(extractRecord({ type: 'user', isSidechain: true, message: { content: '某个子代理的长提示词' } }), null)
    assert.equal(extractRecord({ type: 'user', message: { content: '<task-notification>xxx</task-notification>' } }), null)
    assert.equal(extractRecord({ type: 'user', message: { content: '[Request interrupted by user]' } }), null)
    assert.equal(extractRecord({ type: 'user', message: { content: 'Continue from where you left off.' } }), null)
    assert.equal(extractRecord({ type: 'user', message: { content: '#allow' } }), null)
    assert.equal(extractRecord({ type: 'user', message: { content: '短' } }), null)
})

test('extractRecord: assistant 只取文本块，纯工具调用为 null', () => {
    assert.deepEqual(
        extractRecord({ type: 'assistant', message: { content: [{ type: 'text', text: '回答内容足够长了' }, { type: 'tool_use', name: 'Read', input: {} }] } }),
        { role: 'ai', text: '回答内容足够长了' },
    )
    assert.equal(extractRecord({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }), null)
})

test('extractRecord: summary 记录', () => {
    assert.deepEqual(extractRecord({ type: 'summary', summary: '压缩摘要内容' }), { role: 'summary', text: '压缩摘要内容' })
    assert.equal(extractRecord({ type: 'summary' }), null)
})

test('chunkText: 短文本直通', () => {
    assert.deepEqual(chunkText('短文本', 800, 720), ['短文本'])
})

test('chunkText: 长文本滑窗切块且带重叠', () => {
    const chunks = chunkText('x'.repeat(2000), 800, 720)
    assert.equal(chunks.length, 3)
    assert.equal(chunks[0].length, 800)
    assert.equal(chunks[2].length, 2000 - 1440)
})

test('chunkText: 超长文本封顶 8 窗', () => {
    assert.equal(chunkText('y'.repeat(100000), 800, 720).length, 8)
})

test('rrfFuse: 双列表命中者排最前，结果去重合并', () => {
    const ix = { enc: 'p', metas: [] }
    const mk = (i) => ({ ix, i })
    const fused = rrfFuse([mk(1), mk(2), mk(3)], [mk(3), mk(4)])
    assert.equal(fused[0].i, 3)
    assert.equal(fused.length, 4)
    assert.ok(fused[0].score > fused[1].score)
})

test('keywordScores: 分词命中计分，零命中不入榜', () => {
    const ix = { enc: 'p', n: 2, metas: [{ text: '钉住侧栏宽度支持拖拽调节' }, { text: '完全无关的内容啊' }] }
    const scored = keywordScores('侧栏 拖拽', [ix])
    assert.equal(scored.length, 1)
    assert.equal(scored[0].i, 0)
})

test('keywordScores: 整句短语命中加权高于散词', () => {
    const ix = { enc: 'p', n: 2, metas: [{ text: '钉住侧栏宽度支持拖拽调节' }, { text: '侧栏在这里，拖拽在那里' }] }
    const scored = keywordScores('侧栏宽度', [ix])
    assert.equal(scored[0].i, 0)
})
