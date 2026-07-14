#!/usr/bin/env node
// trans UserPromptSubmit hook：扫用户输入的续接意图词，
// 命中则往上下文注入提示，让 AI 自行决定是否调 trans_scan / trans_search。
// 不命中 → 静默退出，零副作用。
import { writeFileSync, appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ── 调试日志（确认 hook 是否被 Claude Code 调起）──
const LOG = join(homedir(), '.claude', 'trans-hook-debug.log')
const log = (msg) => { try { appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {} }

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
    log(`prompt=${JSON.stringify((prompt||'').slice(0,80))}`)
    if (!prompt || typeof prompt !== 'string') { log('exit: no prompt'); process.exit(0) }

    if (hasIntent(prompt)) {
      log('HIT → injecting hint')
      const hint = [
        '[trans plugin] The user\'s message likely references a past session or prior work.',
        'You have the trans_scan and trans_search MCP tools available.',
        'Use trans_scan to retrieve a resumption brief from a recent session, or trans_search to find specific details across session history.',
        'DO call one of these tools unless you are absolutely certain the user is NOT asking about prior session context.',
        'Memory files alone cannot substitute for session transcript search — they only store what was explicitly saved.',
      ].join(' ')
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: hint,
        }
      }) + '\n')
    }
    log('miss → silent exit')
  } catch (e) { log(`error: ${e.message}`) }
  process.exit(0)
})
setTimeout(() => process.exit(0), 3000)
