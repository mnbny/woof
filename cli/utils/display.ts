import ansis from 'ansis'
import { AsyncLocalStorage } from 'node:async_hooks'

import { isAgent } from './agent.ts'
import { isTTY, terminalHasColor } from './terminal.ts'

export function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function codeBlockText(text: string, { compact = false }: { compact?: boolean } = {}) {
  if (!isTTY() || !terminalHasColor()) return text

  // Fill the remaining columns with the background without trailing spaces or hard wraps.
  const fill = '\u001b[K'
  const content = `   ${text.replaceAll('\n', `${fill}\n   `)}${fill}`
  return ansis.bgHex('#262626').hex('#eeeeee')(compact ? content : `${fill}\n${content}\n${fill}`)
}

// The edit page shows messages as text with Markdown code spans, so code inside them uses backticks.
const markdown = new AsyncLocalStorage<true>()

export function markdownText<Result>(run: () => Result) {
  return markdown.run(true, run)
}

// Agents read plain text, so styles and alignment apply only for people.
function plain() {
  return Boolean(isAgent()) || process.argv.includes('--agent') || markdown.getStore() === true
}

export function inlineCodeText(text: string) {
  if (markdown.getStore()) return `\`${text}\``
  if (plain()) return text

  return ansis.bgHex('#262626').hex('#eeeeee')(` ${text} `)
}

export function mutedText(text: string) {
  return plain() ? text : ansis.dim(text)
}

/** A note beside a prompt message, muted like the hint of a select option. */
export function hintText(text: string) {
  return mutedText(`(${text})`)
}

/** The values start in one column and stay muted, so the labels lead. */
export function fieldsText(fields: [label: string, value: string][]) {
  if (plain()) return fields.map(([label, value]) => `${label}: ${value}`).join('\n')
  const width = Math.max(...fields.map(([label]) => label.length))
  return fields.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${mutedText(value)}`).join('\n')
}

export function badgeText(label: string, color: string) {
  return plain() ? `[${label}]` : ansis.bgHex(color).black(` ${label} `)
}

/** People read one value per line. Agents read the values on one line. A field without values is left out. */
export function listFieldText(label: string, values: string[], plural = `${label}s`) {
  if (!values.length) return []
  const name = values.length === 1 ? label : plural
  if (plain()) return [`${name}: ${values.join(', ')}`]
  return [`${name}:`, ...values.map(value => `  - ${mutedText(value)}`)]
}

/** A script runs when it resolves, so its runtime shows in a badge of its own. A prompt has no runtime badge. */
export function runtimeBadge(kind: string) {
  return kind === 'prompt' ? '' : badgeText(kind, '#ffd787')
}

/** Added lines are green and removed lines are red, as in other diff tools. The colors are 256-color palette entries. */
export function diffText(diff: string) {
  if (plain()) return diff
  return diff
    .split('\n')
    .map(line =>
      line.startsWith('+')
        ? ansis.hex('#87d787')(line)
        : line.startsWith('-')
          ? ansis.hex('#ff8787')(line)
          : line.startsWith('@@')
            ? ansis.dim(line)
            : line,
    )
    .join('\n')
}

/** A registered project that is stored in the root configuration is inline. */
export function inlineBadge() {
  return badgeText('inline', '#dadada')
}

// Each color is an entry of the 256-color palette, so terminals without true color show it unchanged.
const SCOPE_COLORS = { global: '#dadada', project: '#afd7ff' }

/** A shared token is global. A token of the selected project, including an override, belongs to the project. */
export function scopeBadge(origin: 'root' | 'project') {
  const scope = origin === 'root' ? 'global' : 'project'
  return badgeText(scope, SCOPE_COLORS[scope])
}
