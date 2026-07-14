#!/usr/bin/env node
// trans UserPromptSubmit hook：扫用户输入的续接意图词，
// 命中则往上下文注入提示，让 AI 自行决定是否调 trans_scan / trans_search。
// 不命中 → 静默退出，零副作用。

// ── 续接意图正则 ──
// 中文：昨天/上次/之前/那个/记得/上回/前面/接着/继续上次/恢复
// 英文：last time/earlier/previous/remember/resume/pick up where
// 会话 ID 前缀模式：8-4-4 UUID 片段
const INTENT_RE = /昨天|上次|之前[说做写提]|那个.{0,4}(会话|session)|记得.{0,6}(说|做|写|提|改)|上回|前面.{0,4}(说|做|写)|接着上[次回]|继续上[次回]|恢复.{0,4}(会话|session)|last\s*time|earlier.{0,8}(session|conversation)|previous\s*(session|conversation)|remember.{0,8}(we|you|I|last)|pick\s*up\s*where|resume.{0,6}(session|where)|[0-9a-f]{8}-[0-9a-f]{4}/i

let raw = ''
process.stdin.on('data', d => { raw += d })
process.stdin.on('end', () => {
  try {
    const { prompt } = JSON.parse(raw || '{}')
    if (!prompt || typeof prompt !== 'string') { process.exit(0) }

    if (INTENT_RE.test(prompt)) {
      const hint = [
        '[trans 插件提示] 检测到疑似续接/回忆意图。',
        '你可以调用 trans_scan（恢复上次会话断点）或 trans_search（检索历史对话细节）来帮助用户。',
        '请根据用户完整消息判断是否真的需要——如果用户只是随口提到"之前"但不需要历史上下文，忽略本提示即可。',
      ].join(' ')
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: hint,
        }
      }) + '\n')
    }
  } catch { }
  process.exit(0)
})
setTimeout(() => process.exit(0), 3000)
