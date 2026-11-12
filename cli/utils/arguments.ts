import type { ArgumentDescriptions } from './schema.ts'

import * as v from 'valibot'

import { argumentDescriptionsSchema } from './schema.ts'

/** Protect script values from Woof's flag scans, including help, migration, and agent detection. */
export function normalizeGetArguments(input: string[]) {
  if (input.find(arg => !arg.startsWith('-')) !== 'get') return input
  const args = [...input]
  for (let index = args.indexOf('get') + 1; index < args.length; index++) {
    if (args[index] === '--') break
    if (args[index] === '--args' && args[index + 1] !== undefined) args.splice(index, 2, `--args=${args[index + 1]}`)
  }
  return args
}

export function parseArgumentDescriptions(input: string) {
  try {
    return v.parse(argumentDescriptionsSchema, JSON.parse(input))
  } catch {
    throw new Error('--arguments must be a JSON array of objects with a nonempty name and optional description.')
  }
}

export function argumentDescriptionText(args: ArgumentDescriptions) {
  return args.map(arg => `${arg.name}${arg.description ? `: ${arg.description}` : ''}`).join(', ')
}
