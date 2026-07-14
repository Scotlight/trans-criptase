#!/usr/bin/env node
// trans UserPromptSubmit hook：扫用户输入的续接意图词，
// 命中则往上下文注入提示，让 AI 自行决定是否调 trans_scan / trans_search。
// 不命中 → 静默退出，零副作用。

// ── 续接意图正则（三组：中文 / 英文 / 会话ID）──
// 设计取向：软提示，宁可多命中让 AI 自行判断，也不要漏掉口语化的回顾问句。
// 误命中成本极低（就多注入几十 token 的建议，AI 一眼判无关就忽略）；漏命中才是真损失。
const INTENT_PATTERNS = [
  // 中文续接/回忆词：昨天/上次/之前说/那个会话/记得…做/上回/前面说/接着上次/继续上次/恢复会话
  /昨天|前天|上次|上回|之前[说做写提改聊]|那个.{0,4}(会话|session)|记得.{0,6}(说|做|写|提|改|聊)|前面.{0,4}(说|做|写)|接着上[次回]|继续上[次回]|恢复.{0,4}(会话|session)/,
  // 英文续接/回忆词：yesterday（单独，对标中文「昨天」）/ last night|week|time / the other day /
  // earlier…(session|we…) / previous session / remember…(we|you) / pick up where /
  // where we left off / 回顾问句 what did/do we/you/i… / continue our… / carry on
  /yesterday|last\s*(night|week|time|session)|the\s+other\s+day|earlier.{0,10}(session|conversation|we|you|talk)|previous\s*(session|conversation|chat|time|work)|remember.{0,10}(we|you|i|last|that|when)|pick\s*up\s*where|where\s*(we|i|you)\s*left\s*off|what\s*(did|do|were|was)\s*(we|you|i)\b|continue\s*(the|our|where|from|our\s*work)|carry\s*on/i,
  // 裸的会话 UUID 片段（8-4）：用户直接粘会话 ID 时
  /[0-9a-f]{8}-[0-9a-f]{4}/i,
]

const hasIntent = (t) => INTENT_PATTERNS.some((re) => re.test(t))

let raw = ''
process.stdin.on('data', d => { raw += d })
process.stdin.on('end', () => {
  try {
    const { prompt } = JSON.parse(raw || '{}')
    if (!prompt || typeof prompt !== 'string') { process.exit(0) }

    if (hasIntent(prompt)) {
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
