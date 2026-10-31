import { parseArgs } from 'node:util'

import { splitProjectAddress } from './tokens.ts'

type Option = { type: 'boolean' | 'string'; short?: string }

const commandOptions: Record<string, Record<string, Option>> = {
  get: { project: { type: 'string' }, search: { type: 'boolean' } },
  explain: { project: { type: 'string' } },
  validate: { project: { type: 'string' } },
  projects: {},
  export: { project: { type: 'string' } },
  import: { decisions: { type: 'string' } },
  readme: {},
}

export function parseInvocation(rawArgs: string[]) {
  const terminator = rawArgs.indexOf('--')
  const before = terminator < 0 ? rawArgs : rawArgs.slice(0, terminator)
  const after = terminator < 0 ? [] : rawArgs.slice(terminator)
  const migrate = before.includes('--migrate')
  const normalized = [...before.filter(arg => arg !== '--migrate'), ...after]
  const commandIndex = before.findIndex(arg => !arg.startsWith('-'))
  const command = commandIndex < 0 ? undefined : before[commandIndex]
  if (command && !Object.hasOwn(commandOptions, command)) throw new Error(`Unknown command: ${command}`)
  const preceding = commandIndex < 0 ? [...before, ...after] : before.slice(0, commandIndex)
  const following = commandIndex < 0 ? [] : [...before.slice(commandIndex + 1), ...after]
  const common = {
    migrate: { type: 'boolean' as const },
    agent: { type: 'boolean' as const },
    help: { type: 'boolean' as const, short: 'h' },
    version: { type: 'boolean' as const, short: 'v' },
  }
  const root = parseArgs({ args: preceding, options: common, allowPositionals: false })
  const parsed = parseArgs({
    args: following,
    options: { ...common, ...(command ? commandOptions[command] : {}) },
    allowPositionals: true,
  })
  const passive =
    !command ||
    root.values.help === true ||
    root.values.version === true ||
    parsed.values.help === true ||
    parsed.values.version === true
  if (command && !passive) {
    const count = parsed.positionals.length
    if ((command === 'explain' || command === 'import') && count !== 1)
      throw new Error(`${command} requires exactly one argument.`)
    if ((command === 'projects' || command === 'export' || command === 'readme') && count !== 0)
      throw new Error(`${command} accepts no positional arguments.`)
    if (command === 'validate' && count > 1) throw new Error('validate accepts at most one token address.')
    if (
      ['get', 'explain', 'validate'].includes(command) &&
      count === 1 &&
      parsed.positionals[0]!.startsWith('$projects.')
    ) {
      const qualified = splitProjectAddress(parsed.positionals[0]!)
      const project = (parsed.values as Record<string, unknown>)['project']
      if (project && qualified.project !== project)
        throw new Error(
          `Qualified address selects ${qualified.project}, which contradicts --project ${String(project)}.`,
        )
    }
    if (command === 'export' && !(parsed.values as Record<string, unknown>)['project'])
      throw new Error('export requires --project NAME.')
  }
  return { migrate, passive, command, args: normalized }
}
