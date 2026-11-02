import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { parseArgs } from 'node:util'

import { escapeHtml, renderReadmeImage } from './readme-image.ts'

// Match the depth colors of woof tree.
const LEVEL_COLORS = ['#afd7ff', '#afffaf', '#ffd787', '#d7afff', '#ffafaf']

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function renderTree(tree: Record<string, unknown>, depth = 0) {
  const entries = Object.entries(tree).filter(([key]) => key !== '$schemaVersion' && key !== '$metadata')
  return `<ul>${entries
    .map(([key, value]) => {
      let kind = ''
      if (isObject(value) && '$type' in value && '$exec' in value) {
        if (value['$type'] !== 'prompt') kind = ` <span class="kind">[${escapeHtml(String(value['$type']))}]</span>`
        value = value['$exec']
      }
      let content: string
      if (isObject(value)) content = renderTree(value, depth + 1)
      else {
        const text = typeof value === 'string' && value.length ? value : JSON.stringify(value, null, 2)
        const multiline = text.includes('\n')
        content = `${multiline ? '' : ': '}<span class="value${multiline ? ' multiline' : ''}">${escapeHtml(text)}</span>`
      }
      return `<li style="--level-color: ${LEVEL_COLORS[depth % LEVEL_COLORS.length]}"><span class="key">${escapeHtml(key)}</span>${kind}${content}</li>`
    })
    .join('')}</ul>`
}

const STYLES = `
  .tree { font: var(--readme-font); }
  ul { margin: 0; padding: 0; list-style: none; }
  li { position: relative; padding-left: 3ch; overflow-wrap: anywhere; }
  li::before { content: ''; position: absolute; left: .5ch; top: 0; bottom: 0; border-left: 1px solid var(--level-color); }
  li:last-child::before { bottom: auto; height: .825em; }
  li::after { content: ''; position: absolute; left: .5ch; top: .825em; width: 1.5ch; border-top: 1px solid var(--level-color); }
  .key { color: var(--level-color); }
  .kind { opacity: .7; }
  .value { white-space: pre-wrap; }
  .multiline { display: block; padding: 0 0 .5em 2ch; }
`

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { width: { type: 'string', default: '830' }, browser: { type: 'string' }, help: { type: 'boolean' } },
  })
  if (values.help) {
    console.log(
      'Usage: pnpm exec tsx .tools/scripts/render-config.ts <input.json> <output.jpg> [--width 830] [--browser /path/to/chrome]\n\nRender a JSON configuration or snippet as a tree with literal values. Resource objects show their $exec value. Metadata is omitted; references and file paths are not resolved.',
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
  const tree: unknown = JSON.parse(await readFile(input, 'utf8'))
  if (!isObject(tree)) throw new Error('The configuration example must be a JSON object.')
  await renderReadmeImage({
    content: `<div class="tree">${renderTree(tree)}</div>`,
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
