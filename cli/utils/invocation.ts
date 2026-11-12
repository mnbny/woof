import { parseArgs } from 'node:util'

import { normalizeGetArguments } from './arguments.ts'
import { splitProjectAddress } from './tokens.ts'

type Option = { type: 'boolean' | 'string'; short?: string; multiple?: boolean }

const commandOptions: Record<string, Record<string, Option>> = {
  add: {
    arguments: { type: 'string' },
    secret: { type: 'string', multiple: true },
    private: { type: 'boolean' },
    type: { type: 'string' },
    content: { type: 'string' },
    description: { type: 'string' },
    tag: { type: 'string', multiple: true },
    shared: { type: 'boolean' },
    repo: { type: 'boolean' },
    project: { type: 'string' },
  },
  get: { project: { type: 'string' }, search: { type: 'boolean' }, args: { type: 'string' } },
  edit: {
    arguments: { type: 'string' },
    secret: { type: 'string', multiple: true },
    private: { type: 'boolean' },
    'no-private': { type: 'boolean' },
    project: { type: 'string' },
    content: { type: 'string' },
    description: { type: 'string' },
    tag: { type: 'string', multiple: true },
    shared: { type: 'boolean' },
    override: { type: 'boolean' },
  },
  explain: { project: { type: 'string' } },
  validate: { project: { type: 'string' } },
  projects: {},
  tree: { project: { type: 'string' }, repo: { type: 'boolean' } },
  export: { project: { type: 'string' } },
  import: { decisions: { type: 'string' } },
  init: {
    repo: { type: 'boolean' },
    name: { type: 'string' },
    'base-path': { type: 'string', multiple: true },
    'worktree-path': { type: 'string', multiple: true },
  },
  readme: {},
  upgrade: {},
  secret: {},
}

export function parseInvocation(rawArgs: string[]) {
  rawArgs = normalizeGetArguments(rawArgs)
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
    const values = parsed.values as Record<string, unknown>
    if (command === 'edit' && values['private'] && values['no-private'])
      throw new Error('Choose --private or --no-private, not both.')
    if (command === 'tree' && values['repo'] && values['project'] !== undefined)
      throw new Error('Choose --repo or --project, not both.')
    const count = parsed.positionals.length
    if (command === 'secret' && (count !== 1 || migrate))
      throw new Error('Use woof secret KEY. This command does not accept --migrate.')
    if (command === 'upgrade' && migrate) throw new Error('upgrade does not accept --migrate.')
    if (command === 'import' && count !== 1) throw new Error('import requires exactly one argument.')
    // Without an address, explain offers a picker to a person and asks an agent for the address.
    if (command === 'explain' && count > 1) throw new Error('explain accepts one token address.')
    if (['projects', 'export', 'readme', 'upgrade'].includes(command) && count !== 0)
      throw new Error(`${command} accepts no positional arguments.`)
    if (command === 'validate' && count > 1) throw new Error('validate accepts at most one token address.')
    if (command === 'tree' && count > 1) throw new Error('tree accepts at most one path.')
    if ((command === 'add' || command === 'edit') && count > 1)
      throw new Error(`${command} accepts at most one token path.`)
    if (command === 'init' && count > (values['repo'] ? 1 : 0))
      throw new Error('init accepts one location, and only with --repo.')
    if (
      ['get', 'explain', 'validate'].includes(command) &&
      count === 1 &&
      parsed.positionals[0]!.startsWith('$projects.')
    ) {
      const qualified = splitProjectAddress(parsed.positionals[0]!)
      const project = values['project']
      if (project && qualified.project !== project)
        throw new Error(
          `Qualified address selects ${qualified.project}, which contradicts --project ${String(project)}.`,
        )
    }
  }
  return { migrate, passive, command, args: normalized }
}
