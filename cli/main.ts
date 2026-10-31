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
import { parseInvocation } from './utils/invocation.ts'
import { getWoofHome } from './utils/paths.ts'
import { presentError } from './utils/presentation.ts'
import { prepareStartup } from './utils/startup.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = { explain, export: exportProject, get, import: importProject, projects, validate }

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

try {
  const invocation = parseInvocation(process.argv.slice(2))
  await prepareStartup({ migrate: invocation.migrate, passive: invocation.passive, cwd: process.cwd() })
  const rootVersion =
    invocation.args.some(arg => arg === '--version' || arg === '-v') &&
    invocation.args.every(arg => ['--agent', '--version', '-v'].includes(arg))
  const args = rootVersion
    ? ['--version']
    : invocation.args.every(arg => arg === '--agent')
      ? [...invocation.args, '--help']
      : invocation.args
  await runMain(main, { rawArgs: args })
} catch (error) {
  presentError({
    summary: 'Woof could not prepare the invocation.',
    details: error instanceof Error ? error.message : String(error),
    recovery: `Review the arguments and ${getWoofHome('woof.config.json')}; use --migrate only for a supported legacy configuration.`,
  })
  process.exitCode = 1
}
