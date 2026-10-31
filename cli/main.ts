import type { SubCommandsDef } from 'citty'

import { defineCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }
import explain from './commands/explain.ts'
import exportProject from './commands/export.ts'
import get from './commands/get.ts'
import importProject from './commands/import.ts'
import projects from './commands/projects.ts'
import readme from './commands/readme.ts'
import validate from './commands/validate.ts'
import { parseInvocation } from './utils/invocation.ts'
import { getWoofHome } from './utils/paths.ts'
import { presentError } from './utils/presentation.ts'
import { prepareStartup } from './utils/startup.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const subCommands: SubCommandsDef = {
  explain,
  export: exportProject,
  get,
  import: importProject,
  projects,
  readme,
  validate,
}

const main = defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate configuration to the current schema', type: 'boolean' },
  },
  meta: {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
  },
  subCommands,
})

try {
  const invocation = parseInvocation(process.argv.slice(2))
  // The guide must stay readable when configuration is broken, which is when an agent needs it most.
  if (invocation.command !== 'readme' || invocation.migrate)
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
    recovery: `Review the arguments and ${getWoofHome('woof.config.json')}. If Woof reports a pending migration, retry with --migrate.`,
  })
  process.exitCode = 1
}
