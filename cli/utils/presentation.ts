import { autocomplete, isCancel, log, multiline, S_BAR, S_STEP_SUBMIT, select, text } from '@clack/prompts'
import ansis from 'ansis'
import { readFileSync } from 'node:fs'
import { stripVTControlCharacters } from 'node:util'

import { isAgent } from './agent.ts'
import { codeBlockText, runtimeBadge, scopeBadge } from './display.ts'
import { getWoofRoot } from './paths.ts'
import { isTTY } from './terminal.ts'

type TemplateValue = number | string
type PresentationInput = { summary: string; details?: string; recovery?: string }
// Null marks output that a later template in the same run already carries for agents.
type AgentTemplate = { template: string; values?: Record<string, TemplateValue> } | null

const SPINNER_FRAMES = ['◒', '◐', '◓', '◑']

const TEMPLATE_KEY = /\{\{([A-Za-z][A-Za-z0-9-]*)\}\}/g

export function renderTemplate(template: string, values: Record<string, TemplateValue>) {
  return template.replace(TEMPLATE_KEY, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`The presentation template has no value for {{${key}}}.`)
    return String(value)
  })
}

/** Every line that agent mode prints comes from a file in the templates directory. */
export function renderTemplateFile(name: string, values: Record<string, TemplateValue> = {}) {
  const template = readFileSync(getWoofRoot('cli', 'templates', `${name}.md`), 'utf8')
  return renderTemplate(template, values).replace(/\n$/, '')
}

export function agentPresentation() {
  return process.argv.includes('--agent') || Boolean(isAgent())
}

function writeAgentTemplate(agent: AgentTemplate) {
  if (agent) process.stdout.write(`${renderTemplateFile(agent.template, agent.values)}\n`)
}

export function presentResult({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.success(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

export function presentSelection({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.info(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

// A guide line above the block keeps it apart from the message before it.
function writeCodeBlock(code: string) {
  log.message('', { spacing: 0 })
  log.message(codeBlockText(code), { spacing: 0, withGuide: false })
}

/** A notice reports an outcome that changed nothing, such as a cancellation or an edit without changes. */
export function presentNotice({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.warn(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

/** A cancellation changes nothing, so it is a notice. It exits with status 130. */
export function presentCancel(summary: string) {
  presentNotice({ summary }, null)
  process.exitCode = 130
}

export function presentConflict(
  { summary, details, notes, recovery }: PresentationInput & { notes?: string },
  agent: AgentTemplate,
) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.warn(summary)
  if (details) writeCodeBlock(details)
  if (notes) log.message(notes)
  if (recovery) log.info(recovery)
}

export function presentError({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.error(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

/** People copy the value, so it reads as code. Agents get the value from their template. */
export function presentCode(message: string, code: string, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.info(message)
  writeCodeBlock(code)
}

export async function chooseOption({
  message,
  options,
}: {
  message: string
  options: { value: string; label: string; hint?: string }[]
}) {
  if (agentPresentation() || !isTTY()) return undefined
  const selected = await select({ message, options })
  return isCancel(selected) ? undefined : selected
}

/** Warnings read the same for people and agents, so both modes use the template. */
export function presentWarning(template: string, values: Record<string, TemplateValue> = {}) {
  process.stderr.write(`${renderTemplateFile(template, values)}\n`)
}

/** Enter adds a line, so pasted text with blank lines cannot submit early. Tab reaches the submit button. */
export async function enterMultiline(message: string) {
  if (agentPresentation() || !isTTY()) return undefined
  const value = await multiline({
    message,
    showSubmit: true,
    validate: input => (input?.trim() ? undefined : 'Enter a value.'),
  })
  return isCancel(value) ? undefined : (value ?? '').trimEnd()
}

export function writePayload(payload: string) {
  process.stdout.write(payload)
}

export type TokenChoice = {
  path: string
  origin: 'root' | 'project'
  kind: string
  target?: string | undefined
  description?: string | undefined
  tags?: string[] | undefined
}

// The prompt wraps a row at the terminal width less its gutter, and it measures the gutter with its escape codes.
const HINT_RESERVE = 24

/** An alias has no description of its own, so people see the description and tags of the token that it resolves to. */
export function aliasedMetadata<Token extends TokenChoice>(token: Token, tokens: Token[]) {
  let current: TokenChoice | undefined = token
  for (const seen = new Set<string>(); current?.target && !seen.has(current.path);) {
    seen.add(current.path)
    current = tokens.find(candidate => candidate.path === current!.target)
  }
  return { description: current?.description, tags: current?.tags }
}

/**
 * A searchable list of tokens. The search starts with the given terms and matches every word against the path, the
 * description, the tags, and the alias target. A row shows the path, the scope, and the runtime of a script. The hint
 * of the focused row gives the description and tags, cut to one line.
 */
export async function chooseToken({
  message,
  tokens,
  query = '',
}: {
  message: string
  tokens: TokenChoice[]
  query?: string
}) {
  if (agentPresentation() || !isTTY()) return undefined
  const width = Math.max(...tokens.map(token => token.path.length))
  const searchable = new Map(
    tokens.map(token => {
      const { description, tags } = aliasedMetadata(token, tokens)
      return [token.path, [token.path, description, ...(tags ?? []), token.target].join(' ').toLowerCase()]
    }),
  )
  const options = tokens.map(token => {
    const runtime = token.target ? '' : runtimeBadge(token.kind)
    const label = `${token.path.padEnd(width)}  ${scopeBadge(token.origin)}${runtime ? ` ${runtime}` : ''}`
    const { description, tags } = aliasedMetadata(token, tokens)
    const detail = [description, tags?.length ? `tags: ${tags.join(', ')}` : undefined].filter(Boolean).join(' · ')
    const room = (process.stdout.columns ?? 80) - stripVTControlCharacters(label).length - HINT_RESERVE
    const hint = room < 20 ? '' : detail.length > room ? `${detail.slice(0, room - 1)}…` : detail
    return { value: token.path, label, ...(hint ? { hint } : {}) }
  })
  const selected = await autocomplete({
    message,
    options,
    initialUserInput: query,
    filter: (search, option) =>
      search
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(word => searchable.get(option.value)!.includes(word)),
  })
  return isCancel(selected) ? undefined : selected
}

/** An optional prompt returns an empty string for no answer and undefined only for a cancellation. */
export async function enterText(message: string, options: { initialValue?: string; optional?: boolean } = {}) {
  if (agentPresentation() || !isTTY()) return undefined
  const value = await text({
    message,
    ...(options.initialValue ? { initialValue: options.initialValue } : {}),
    validate: input => (options.optional || input?.trim() ? undefined : 'Enter a value.'),
  })
  return isCancel(value) ? undefined : (value ?? '').trim()
}

/**
 * The browser opens after a short countdown, so the person can read the address first. The returned stop ends the
 * spinner with a message, or clears it. Clack's spinner reads keys in raw mode and exits on Ctrl+C by itself, so this
 * one leaves the input alone and Ctrl+C reaches the interrupt handler of the command.
 */
export function browserCountdown(open: () => void, seconds = 3) {
  const output = process.stdout
  let message = `Opening browser in ${seconds}s`
  let frame = 0
  const draw = () => output.write(`\r\u001b[2K${ansis.magenta(SPINNER_FRAMES[frame]!)}  ${message}`)
  const showCursor = () => output.write('\u001b[?25h')
  output.write(`${ansis.gray(S_BAR)}\n\u001b[?25l`)
  draw()
  process.once('exit', showCursor)
  const spin = setInterval(() => {
    frame = (frame + 1) % SPINNER_FRAMES.length
    draw()
  }, 80)
  let left = seconds
  const count = setInterval(() => {
    left -= 1
    if (left > 0) {
      message = `Opening browser in ${left}s`
      return
    }
    clearInterval(count)
    open()
    message = 'Waiting for save in browser'
  }, 1000)
  return (done?: string) => {
    clearInterval(spin)
    clearInterval(count)
    process.off('exit', showCursor)
    // A cleared spinner also removes its guide line, because the next message brings its own.
    output.write(done ? `\r\u001b[2K${ansis.green(S_STEP_SUBMIT)}  ${done}\n` : '\r\u001b[2K\u001b[1A\r\u001b[2K')
    showCursor()
  }
}
