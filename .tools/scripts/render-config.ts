import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { escapeHtml, renderReadmeImage } from './readme-image.ts'

// Match the depth colors of the tree renderer.
const LEVEL_COLORS = ['#afd7ff', '#afffaf', '#ffd787', '#d7afff', '#ffafaf']

function highlightJson(source: string) {
  const tokens = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}[\],:]/g
  let html = ''
  let offset = 0
  let depth = -1
  for (const match of source.matchAll(tokens)) {
    const token = match[0]
    const end = match.index + token.length
    if (token === '{') depth++
    else if (token === '}') depth--
    let kind = 'punctuation'
    if (token.startsWith('"')) {
      kind = source.slice(end).trimStart().startsWith(':') ? `key-${depth % LEVEL_COLORS.length}` : 'string'
    } else if (/^-?\d/.test(token)) kind = 'number'
    else if (/^(true|false|null)$/.test(token)) kind = 'literal'
    html += `${escapeHtml(source.slice(offset, match.index))}<span class="${kind}">${escapeHtml(token)}</span>`
    offset = end
  }
  return html + escapeHtml(source.slice(offset))
}

const STYLES = `
  main { position: relative; }
  .language { position: absolute; top: 12px; right: 32px; font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: .12em; opacity: .55; }
  pre { margin: 0; font: var(--readme-font); }
  code { font: inherit; }
  .line { display: block; padding-left: var(--indent); text-indent: calc(-1 * var(--indent)); white-space: pre-wrap; overflow-wrap: anywhere; }
  ${LEVEL_COLORS.map((color, depth) => `.key-${depth} { color: ${color}; }`).join('\n  ')}
  .string { color: #e7bf7f; }
  .number { color: #ffafaf; }
  .literal { color: #d7afff; }
  .punctuation { color: #a99a9f; }
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { width: { type: 'string', default: '830' }, browser: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx .tools/scripts/render-config.ts <input.json> <output.jpg> [--width 830] [--browser /path/to/chrome]\n\nRender a JSON example as a syntax-highlighted code block. Preserves source formatting; references and file paths are not resolved.',
    )
    return
  }
  const [input, output] = positionals
  const width = Number(values.width)
  if (!input || !output || positionals.length !== 2 || !Number.isInteger(width) || width < 240 || width > 4096) {
    throw new Error(
      'Provide an input JSON file, an output JPEG, and a width between 240 and 4096 CSS pixels. Use --help for usage.',
    )
  }

  const source = (await readFile(input, 'utf8')).replace(/\r\n/g, '\n').trimEnd()
  JSON.parse(source)
  const lines = highlightJson(source)
    .split('\n')
    .map(line => {
      const indent = line.match(/^ */)?.[0].length ?? 0
      return `<span class="line" style="--indent: ${indent}ch">${line || ' '}</span>`
    })
    .join('')
  await renderReadmeImage({
    content: `<span class="language">JSON</span><pre><code>${lines}</code></pre>`,
    styles: STYLES,
    output,
    width,
    browserPath: values.browser,
  })
}

await main().catch((error: unknown) => {
  console.error(`render-config: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
