import { isCancel, log, select } from '@clack/prompts'

import prompts from '../prompts/agent.json' with { type: 'json' }
import { isAgent } from './agent.ts'
import { codeBlockText } from './display.ts'
import { isTTY } from './terminal.ts'

type TemplateValue = number | string
type PresentationInput = { summary: string; details?: string; recovery?: string }

const TEMPLATE_KEY = /\{\{([A-Za-z][A-Za-z0-9-]*)\}\}/g

export function renderTemplate(template: string, values: Record<string, TemplateValue>) {
  return template.replace(TEMPLATE_KEY, (_, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`The presentation template has no value for {{${key}}}.`)
    return String(value)
  })
}

export function agentPresentation() {
  return process.argv.includes('--agent') || Boolean(isAgent())
}

function renderAgentTemplate(template: keyof typeof prompts, values: Record<string, TemplateValue>) {
  return `${renderTemplate(prompts[template], values)}\n`
}

function optionalSection(value: string | undefined) {
  return value ? `\n\n${value}` : ''
}

export function presentResult({ summary, details, recovery }: PresentationInput) {
  if (agentPresentation()) {
    process.stdout.write(
      renderAgentTemplate('result', {
        summary,
        details: optionalSection(details),
        recovery: optionalSection(recovery),
      }),
    )
    return
  }
  log.success(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

export function presentSelection({ summary, details, recovery }: PresentationInput) {
  if (agentPresentation()) {
    process.stdout.write(
      renderAgentTemplate('selection', {
        summary,
        candidates: optionalSection(details),
        recovery: optionalSection(recovery),
      }),
    )
    return
  }
  log.info(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

export function presentConflict({ summary, details, recovery }: PresentationInput) {
  if (agentPresentation()) {
    process.stdout.write(
      renderAgentTemplate('conflict', {
        summary,
        diff: optionalSection(details),
        recovery: optionalSection(recovery),
      }),
    )
    return
  }
  log.warn(summary)
  if (details) log.message(codeBlockText(details), { spacing: 0, withGuide: false })
  if (recovery) log.info(recovery)
}

export function presentError({ summary, details, recovery }: PresentationInput) {
  if (agentPresentation()) {
    process.stdout.write(
      renderAgentTemplate('error', {
        summary,
        details: optionalSection(details),
        recovery: optionalSection(recovery),
      }),
    )
    return
  }
  log.error(summary)
  if (details) log.message(details)
  if (recovery) log.info(recovery)
}

export function presentRecovery(summary: string, steps: string) {
  if (agentPresentation()) {
    process.stdout.write(renderAgentTemplate('recovery', { summary, steps }))
    return
  }
  log.info(`${summary}\n\n${steps}`)
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

export function writePayload(payload: string) {
  process.stdout.write(payload)
}
