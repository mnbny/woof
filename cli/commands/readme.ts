import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import manifest from '../../package.json' with { type: 'json' }
import { presentError } from '../utils/presentation.ts'

function readText(file: string) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

// The source entry and the bundle sit at different depths, so search upward. Only a README beside
// Woof's own manifest counts, so a copied bundle cannot print an unrelated project's README.
function findReadme() {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const readme = readText(join(directory, 'README.md'))
    const packageText = readText(join(directory, 'package.json'))
    if (readme !== undefined && packageText !== undefined) {
      try {
        if ((JSON.parse(packageText) as { name?: unknown }).name === manifest.name) return readme
      } catch {
        // An unreadable manifest belongs to some other directory; keep searching.
      }
    }
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
  },
  meta: { description: 'Print the user guide. Agents: run this first to learn what Woof can do', name: 'readme' },
  run({ rawArgs }) {
    try {
      const { positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: { agent: { type: 'boolean' }, migrate: { type: 'boolean' } },
      })
      if (positionals.length) throw new Error('Readme does not accept positional arguments.')
      const readme = findReadme()
      if (readme === undefined)
        throw new Error('No Woof README.md was found beside the package manifest above the running entry.')
      process.stdout.write(readme)
    } catch (error) {
      presentError({
        summary: 'Woof could not print its user guide.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Run Woof from its checkout or an installed package; a standalone bundle copied elsewhere has no guide.',
      })
      process.exitCode = 1
    }
  },
})
