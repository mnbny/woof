import type { CommandMeta, SubCommandsDef } from 'citty'

import tab from '@bomb.sh/tab/citty'
import { defineCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }
import explain from './commands/explain.ts'
import exportProject from './commands/export.ts'
import get from './commands/get.ts'
import importProject from './commands/import.ts'
import projects from './commands/projects.ts'
import validate from './commands/validate.ts'
import { initializeWoofHome } from './utils/bootstrap.ts'
import { ConfigurationNotFoundError, readRootConfiguration } from './utils/config.ts'
import { getWoofHome } from './utils/paths.ts'
import { presentError } from './utils/presentation.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = { explain, export: exportProject, get, import: importProject, projects, validate }

const main = defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
  },
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
const helpRequested = rawArgs.length === 0 || rawArgs.includes('--help')
const migrationRequested = rawArgs.includes('--migrate')

if (migrationRequested) {
  await runMain(main, { rawArgs })
} else {
  if (!helpRequested && rawArgs[0] !== 'complete') {
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
  } else if (rawArgs[0] !== 'complete') {
    try {
      readRootConfiguration()
    } catch (error) {
      if (!(error instanceof ConfigurationNotFoundError)) {
        presentError({
          summary: 'Woof could not read personal configuration.',
          details: error instanceof Error ? error.message : String(error),
          recovery: `Review ${getWoofHome('woof.config.json')} and correct it, or use woof validate --migrate for a supported legacy configuration.`,
        })
        process.exit(1)
      }
    }
  }

  await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] })
}
