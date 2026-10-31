import { isCancel, log, select, text } from '@clack/prompts'
import { readFileSync } from 'node:fs'

import { isAgent } from './agent.ts'
import { codeBlockText } from './display.ts'
import { getWoofRoot } from './paths.ts'
import { isTTY } from './terminal.ts'

type TemplateValue = number | string
type PresentationInput = { summary: string; details?: string; recovery?: string }
// Null marks output that a later template in the same run already carries for agents.
type AgentTemplate = { template: string; values?: Record<string, TemplateValue> } | null

const TEMPLATE_KEY = /\{\{([A-Za-z][A-Za-z0-9-]*)\}\}/g

export function renderTemplate(template: string, values: Record<string, TemplateValue>) {
  return template.replace(TEMPLATE_KEY, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`The presentation template has no value for {{${key}}}.`)
    return String(value)
  })
}

// Every line that agent mode prints comes from a file in the templates directory.
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

export function presentConflict({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.warn(summary)
  if (details) log.message(codeBlockText(details), { spacing: 0, withGuide: false })
  if (recovery) log.info(recovery)
}

export function presentError({ summary, details, recovery }: PresentationInput, agent: AgentTemplate) {
  if (agentPresentation()) return writeAgentTemplate(agent)
  log.error(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
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

// Warnings read the same for people and agents, so both modes use the template.
export function presentWarning(template: string, values: Record<string, TemplateValue> = {}) {
  process.stderr.write(`${renderTemplateFile(template, values)}\n`)
}

export function writePayload(payload: string) {
  process.stdout.write(payload)
}

export async function enterText(message: string) {
  if (agentPresentation() || !isTTY()) return undefined
  const value = await text({ message, validate: input => (input?.trim() ? undefined : 'Enter a value.') })
  return isCancel(value) ? undefined : value.trim()
}
