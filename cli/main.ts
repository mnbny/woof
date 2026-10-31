import type { CommandMeta, SubCommandsDef } from 'citty'

import tab from '@bomb.sh/tab/citty'
import { defineCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }
import customize from './commands/customize.ts'
import upgrade from './commands/upgrade.ts'
import { isAgent } from './utils/agent.ts'
import { initializeWoofHome } from './utils/bootstrap.ts'
import {
  ConfigurationNotFoundError,
  readRootConfiguration,
  readWoofConfig,
  WoofConfigUpgradeRequiredError,
} from './utils/config.ts'
import { getWoofHome } from './utils/paths.ts'
import { presentError } from './utils/presentation.ts'

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
const legacyCommands = ['customize', 'upgrade']
const legacyCommand = legacyCommands.includes(rawArgs[0] ?? '')
const helpRequested = rawArgs.length === 0 || rawArgs.includes('--help')

if (!legacyCommand && !helpRequested && rawArgs[0] !== 'complete') {
  try {
    await initializeWoofHome()
    readRootConfiguration()
  } catch (error) {
    presentError({
      summary: 'Woof could not prepare personal configuration.',
      details: error instanceof Error ? error.message : String(error),
      recovery: `Review ${getWoofHome('woof.config.json')}. Existing files are never rewritten; correct the reported issue and retry.`,
    })
    process.exit(1)
  }
} else {
  let checkLegacyConfiguration = true
  if (!legacyCommand && helpRequested && rawArgs[0] !== 'complete') {
    try {
      readRootConfiguration()
      checkLegacyConfiguration = false
    } catch (error) {
      if (error instanceof ConfigurationNotFoundError) checkLegacyConfiguration = false
    }
  }

  if (checkLegacyConfiguration)
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
        if (!legacyCommand) process.exit(1)
      }
    }
}

await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] })
