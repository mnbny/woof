import type { CommandMeta, SubCommandsDef } from 'citty'

import tab from '@bomb.sh/tab/citty'
import { defineCommand, runMain } from 'citty'
import { parseArgs } from 'node:util'

import manifest from '../package.json' with { type: 'json' }
import { initializeWoofHome } from './utils/bootstrap.ts'
import { ConfigurationNotFoundError, readRootConfiguration } from './utils/config.ts'
import { migrateConfigurationDocument } from './utils/migrations.ts'
import { getWoofHome } from './utils/paths.ts'
import { presentError, presentResult } from './utils/presentation.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = {}

const main = defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
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
  try {
    const { values } = parseArgs({
      args: rawArgs,
      allowPositionals: false,
      options: { agent: { type: 'boolean' }, migrate: { type: 'boolean' } },
    })
    if (values.migrate !== true) throw new Error('Migration requires an explicit --migrate.')
    const migrated = await migrateConfigurationDocument()
    presentResult(
      migrated
        ? {
            summary: `Migrated ${migrated.file} from ${migrated.from} to ${migrated.to}.`,
            recovery: 'Review the migrated configuration, then retry the intended command without --migrate.',
          }
        : { summary: `Configuration already uses the current schema; no migration was needed.` },
    )
  } catch (error) {
    presentError({
      summary: 'Woof could not migrate personal configuration.',
      details: error instanceof Error ? error.message : String(error),
      recovery:
        'Correct the reported issue before retrying. Newer configuration needs a compatible Woof release. Ordinary commands never migrate implicitly.',
    })
    process.exitCode = 1
  }
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
          recovery: `Review ${getWoofHome('woof.config.json')} and correct it, or use woof --migrate for a supported legacy configuration.`,
        })
        process.exit(1)
      }
    }
  }

  await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] })
}
