import { expect, test } from 'vitest'

import { isAgent } from '../../../cli/utils/agent.ts'

test('detects Kiro only when both execution channels are present', () => {
  expect(isAgent({ AGENT_CONTEXT_OUT: '/tmp/context' })).toBeUndefined()
  expect(isAgent({ AGENT_DISPLAY_OUT: '/tmp/display' })).toBeUndefined()
  expect(isAgent({ AGENT_CONTEXT_OUT: '/tmp/context', AGENT_DISPLAY_OUT: '/tmp/display' })).toBe('Kiro')
})

test('keeps human mode when providers are installed but no agent is running', () => {
  expect(
    isAgent({
      CLAUDECODE: '',
      CLAUDE_CONFIG_DIR: '/tmp/claude',
      AGENT: '',
      CURSOR_TRACE_ID: '1',
      TERM_PROGRAM: 'kiro',
      KIRO_HOME: '/tmp/kiro',
      GROK_HOME: '/tmp/grok',
      GROK_AGENT: 'grok-build',
      PI_CODING_AGENT_DIR: '/tmp/pi',
      COPILOT_GITHUB_TOKEN: 'test-token',
      ANTIGRAVITY_APP_DATA_DIR: '/tmp/antigravity',
      GEMINI_CLI_HOME: '/tmp/gemini',
    }),
  ).toBeUndefined()
})

test('detects Antigravity tool execution before an inherited Gemini marker', () => {
  for (const marker of ['ANTIGRAVITY_AGENT', 'ANTIGRAVITY_CONVERSATION_ID']) {
    expect(isAgent({ [marker]: 'present', GEMINI_CLI: '1' })).toBe('Antigravity CLI')
    expect(isAgent({ [marker]: '' })).toBeUndefined()
  }
})

test('labels Devin shell commands without overriding a specific caller marker', () => {
  expect(isAgent({ AI_AGENT: 'devin_3000.11.92_agent' })).toBe('Devin CLI')
  expect(isAgent({ AI_AGENT: 'devin_3000.11.92_agent', CODEX_THREAD_ID: 'thread' })).toBe('Codex')
  expect(isAgent({ AI_AGENT: 'devin_other_tool' })).toBe('AI agent')
  expect(isAgent({ DEVIN_MODEL: 'opus', DEVIN_SESSIONS_DIR: '/tmp/sessions' })).toBeUndefined()
})
