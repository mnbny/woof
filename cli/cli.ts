import { isAgent } from './utils/agent.ts'
import { normalizeGetArguments } from './utils/arguments.ts'

process.argv = [...process.argv.slice(0, 2), ...normalizeGetArguments(process.argv.slice(2))]

// Color libraries read their environment on import, including help and error output.
if (process.argv.includes('--agent') || isAgent()) {
  process.env['NO_COLOR'] = '1'
  delete process.env['FORCE_COLOR']
}

await import('./main.ts')
