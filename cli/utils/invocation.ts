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
}

export function parseInvocation(rawArgs: string[]) {
  const terminator = rawArgs.indexOf('--')
  const before = terminator < 0 ? rawArgs : rawArgs.slice(0, terminator)
  const after = terminator < 0 ? [] : rawArgs.slice(terminator)
  const migrate = before.includes('--migrate')
  const normalized = [...before.filter(arg => arg !== '--migrate'), ...after]
  const commandIndex = before.findIndex(arg => !arg.startsWith('-'))
  const command = commandIndex < 0 ? undefined : before[commandIndex]
  if (command && command !== 'complete' && !Object.hasOwn(commandOptions, command))
    throw new Error(`Unknown command: ${command}`)
  if (command === 'complete') {
    const rootFlags = before.slice(0, commandIndex).filter(arg => arg !== '--migrate')
    if (rootFlags.some(arg => !['--agent', '--help', '-h', '--version', '-v'].includes(arg)))
      throw new Error('Invalid completion arguments.')
    const args = before.slice(commandIndex + 1).filter(arg => arg !== '--migrate')
    const validHelp = args.length === 1 && ['--help', '-h', '--version', '-v'].includes(args[0]!)
    const validShell = args.length === 1 && ['zsh', 'bash', 'fish', 'powershell', 'fig'].includes(args[0]!)
    if (!(validHelp || validShell || (args.length === 0 && terminator >= 0)))
      throw new Error('Completion requires a supported shell or -- followed by completion arguments.')
    return { migrate, passive: true, args: normalized }
  }
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
    if ((command === 'projects' || command === 'export') && count !== 0)
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
  return { migrate, passive, args: normalized }
}
