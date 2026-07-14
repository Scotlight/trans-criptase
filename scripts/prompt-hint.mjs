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
        '[trans plugin] The user is asking about a PAST conversation / prior session work.',
        'This information is NOT in the current workspace source code — do NOT answer by running glob/grep/cat over project files; that searches code, not past dialogue. The dialogue lives only in session transcripts, reachable via the trans MCP tools.',
        'Before answering, your FIRST action must be one of:',
        '• trans_search — find specific details across session history (current project by default);',
        '• trans_scan — pull a resumption brief from a recent session.',
        'CROSS-PROJECT: if the prior work happened in a DIFFERENT project/folder than the current one, do NOT use allProjects (it re-scans every index and degrades as projects pile up). Instead call trans_projects FIRST to locate the target project\'s real path, then pass that exact path to trans_search / trans_scan via their `project` param to search just that one project.',
        'Only skip these tools if you are certain the user is asking about CURRENT code, not a past conversation.',
        'Memory files alone cannot substitute for transcript search — they only store what was explicitly saved.',
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
