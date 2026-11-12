import type { SubCommandsDef } from 'citty'

import { defineCommand, runCommand, runMain } from 'citty'

import manifest from '../package.json' with { type: 'json' }
import add from './commands/add.ts'
import edit from './commands/edit.ts'
import explain from './commands/explain.ts'
import exportProject from './commands/export.ts'
import get from './commands/get.ts'
import importProject from './commands/import.ts'
import init from './commands/init.ts'
import projects from './commands/projects.ts'
import readme from './commands/readme.ts'
import secret, { reportSecretError } from './commands/secret.ts'
import tree from './commands/tree.ts'
import upgrade from './commands/upgrade.ts'
import validate from './commands/validate.ts'
import { parseInvocation } from './utils/invocation.ts'
import { getWoofHome } from './utils/paths.ts'
import { agentPresentation, presentError } from './utils/presentation.ts'
import { recommendExecutionSkill } from './utils/skill.ts'
import { prepareStartup } from './utils/startup.ts'

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code !== 'EPIPE') throw error
})

const commandName = process.argv.slice(2).find(arg => !arg.startsWith('-'))
const secretInvocation = commandName === 'secret'

// Help and parse failures exit inside citty, so only an exit hook reaches every agent run.
process.once('exit', () => {
  if (!secretInvocation && commandName !== 'upgrade' && agentPresentation()) recommendExecutionSkill()
})

const subCommands: SubCommandsDef = {
  add,
  edit,
  explain,
  export: exportProject,
  get,
  import: importProject,
  init,
  projects,
  readme,
  secret,
  tree,
  upgrade,
  validate,
}

const main = defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate configuration to the current schema', type: 'boolean' },
  },
  meta: {
    name: 'woof',
    version: manifest.version,
    description: manifest.description,
  },
  subCommands,
})

try {
  const invocation = parseInvocation(process.argv.slice(2))
  // The guide must stay readable when configuration is broken, which is when an agent needs it most.
  if (
    invocation.command !== 'secret' &&
    invocation.command !== 'upgrade' &&
    (invocation.command !== 'readme' || invocation.migrate)
  )
    await prepareStartup({ migrate: invocation.migrate, passive: invocation.passive, cwd: process.cwd() })
  const rootVersion =
    invocation.args.some(arg => arg === '--version' || arg === '-v') &&
    invocation.args.every(arg => ['--agent', '--version', '-v'].includes(arg))
  const args = rootVersion
    ? ['--version']
    : invocation.args.every(arg => arg === '--agent')
      ? [...invocation.args, '--help']
      : invocation.args
  // A key after -- can itself be --help. Avoid citty's help scan for active raw lookups.
  if (invocation.command === 'secret' && !invocation.passive) await runCommand(main, { rawArgs: args })
  else await runMain(main, { rawArgs: args })
} catch (error) {
  if (secretInvocation) {
    reportSecretError(error)
  } else {
    const details = error instanceof Error ? error.message : String(error)
    const configuration = getWoofHome('woof.config.json')
    presentError(
      {
        summary: 'woof could not prepare the invocation.',
        details,
        recovery: `Review the arguments and ${configuration}. If woof reports a pending migration, retry with --migrate.`,
      },
      { template: 'invocation-error', values: { details, configuration } },
    )
    process.exitCode = 1
  }
}
