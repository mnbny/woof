import type { CommandMeta, SubCommandsDef } from 'citty'

import tab from '@bomb.sh/tab/citty'
import { defineCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }
import customize from './commands/customize.ts'
import upgrade from './commands/upgrade.ts'
import { isAgent } from './utils/agent.ts'
import { readWoofConfig, WoofConfigUpgradeRequiredError } from './utils/config.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = { customize, upgrade }

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

try {
  readWoofConfig()
} catch (error) {
  if (rawArgs[0] !== 'complete') {
    const message = error instanceof Error ? error.message : String(error)
    const recovery =
      error instanceof Error && error.cause instanceof WoofConfigUpgradeRequiredError
        ? 'woof upgrade'
        : 'woof customize'
    const agentFlag = rawArgs.includes('--agent') || isAgent() ? ' --agent' : ''
    console.error(
      `${message}\n\nResolve your Woof configuration issue with:\n  ${recovery}${agentFlag}\nThen retry your command.`,
    )
    if (!['customize', 'upgrade'].includes(rawArgs[0] ?? '')) process.exit(1)
  }
}

await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] })
