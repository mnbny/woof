export function isAgent(env: NodeJS.ProcessEnv = process.env) {
  if (env['CLAUDECODE']) return 'Claude Code'
  if (env['CODEX_THREAD_ID'] || env['CODEX_CI'] || env['CODEX_SANDBOX'] || env['CODEX_SANDBOX_NETWORK_DISABLED'])
    return 'Codex'
  if (env['ANTIGRAVITY_AGENT'] || env['ANTIGRAVITY_CONVERSATION_ID']) return 'Antigravity CLI'
  if (env['GEMINI_CLI']) return 'Gemini CLI'
  if (env['CURSOR_AGENT']) return 'Cursor'
  if (env['COPILOT_CLI']) return 'GitHub Copilot CLI'
  if (env['OPENCODE'] || env['OPENCODE_CLIENT']) return 'OpenCode'
  if (env['CLINE_ACTIVE']) return 'Cline'
  if (env['PI_CODING_AGENT'] || env['PI_SESSION_ID']) return 'pi'
  if (env['ROO_ACTIVE'] || env['ROO_CLI_RUNTIME']) return 'Roo Code'
  // Kiro exports both channels only while its agent runs a shell command.
  if (env['AGENT_CONTEXT_OUT'] && env['AGENT_DISPLAY_OUT']) return 'Kiro'
  if (/^devin_[^\s]+_agent$/.test(env['AI_AGENT'] ?? '')) return 'Devin CLI'
  if (env['AI_AGENT'] || env['AGENT']) return 'AI agent'
  return undefined
}
