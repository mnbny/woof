import ansis from 'ansis'

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
