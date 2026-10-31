import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { getWoofRoot } from '../utils/paths.ts'
import { presentError } from '../utils/presentation.ts'

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
  },
  meta: { description: 'Print the user guide. Agents: run this first to learn what woof can do', name: 'readme' },
  run({ rawArgs }) {
    try {
      const { positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: { agent: { type: 'boolean' } },
      })
      if (positionals.length) throw new Error('Readme does not accept positional arguments.')
      process.stdout.write(readFileSync(getWoofRoot('README.md'), 'utf8'))
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'woof could not print its user guide.',
          details,
          recovery:
            'Run woof from its checkout or an installed package; a standalone bundle copied elsewhere has no guide.',
        },
        { template: 'readme-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
