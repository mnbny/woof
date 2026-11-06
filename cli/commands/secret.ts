import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'
import * as v from 'valibot'

import { renderTemplateFile } from '../utils/presentation.ts'
import { tokenPathSchema } from '../utils/schema.ts'
import { createSecretLookup, MissingSecretsError } from '../utils/secrets.ts'

export function reportSecretError(error: unknown) {
  let details = error instanceof Error ? error.message : String(error)
  if (error instanceof MissingSecretsError)
    details +=
      '\nAdd the values locally to woof.secrets.json in woof home, then retry. Keep values out of the conversation.'
  // stdout is exclusively the requested value, including on invocation and lookup failures.
  process.stderr.write(`${renderTemplateFile('secret-error', { details })}\n`)
  process.exitCode = 1
}

export default defineCommand({
  meta: { name: 'secret', description: 'Read one local secret for shell command substitution' },
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    key: { description: 'Secret token path', type: 'positional', required: true },
  },
  run({ rawArgs }) {
    try {
      const { positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: { agent: { type: 'boolean' } },
      })
      if (positionals.length !== 1 || !v.is(tokenPathSchema, positionals[0]))
        throw new Error('Supply one secret token path: woof secret PATH.')
      process.stdout.write(createSecretLookup()(positionals[0]!))
    } catch (error) {
      reportSecretError(error)
    }
  },
})
