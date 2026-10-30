import type { CommandMeta, SubCommandsDef } from 'citty'

import tab from '@bomb.sh/tab/citty'
import { defineCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = {}

const main = defineCommand({
  meta: {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  },
  subCommands,
})

await tab(main)

// Shells need this command, but it does not belong in the normal help listing.
const completion = subCommands['complete']
if (completion && typeof completion === 'object' && 'meta' in completion) {
  completion.meta = { ...(completion.meta as CommandMeta), hidden: true }
}

const rawArgs = process.argv.slice(2)
await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] })
