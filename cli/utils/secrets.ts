import type { SecretBindings } from './schema.ts'

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import * as v from 'valibot'

import { getWoofHome } from './paths.ts'
import { secretBindingsSchema, secretKeySchema } from './schema.ts'

export const SECRETS_FILE = 'woof.secrets.json'

/** Checks names and physical identity so links cannot accidentally bundle the store. */
export function assertNotSecretsFile(file: string, home = getWoofHome()) {
  const store = resolve(home, SECRETS_FILE)
  if (basename(file).toLowerCase() === SECRETS_FILE || resolve(file) === store)
    throw new Error('The secrets store cannot be used as a configuration, resource, or import destination.')
  let physical: string
  try {
    physical = realpathSync(file)
  } catch {
    // Callers decide whether an unreadable path is an error or literal token content.
    return
  }
  if (basename(physical).toLowerCase() === SECRETS_FILE)
    throw new Error('The secrets store cannot be used as a configuration, resource, or import destination.')
  let source
  let target
  try {
    source = statSync(store)
    target = statSync(physical)
  } catch {
    // An unavailable store must not block catalog operations that do not use secrets.
    return
  }
  if (source.dev === target.dev && source.ino === target.ino)
    throw new Error('The secrets store cannot be used as a configuration, resource, or import destination.')
}

export function parseSecretBindings(entries: string[]) {
  const bindings: SecretBindings = {}
  for (const entry of entries) {
    const index = entry.indexOf('=')
    if (index < 1) throw new Error('Secret bindings use ENV_NAME=secret.key. Supply names, never values.')
    const name = entry.slice(0, index)
    const key = entry.slice(index + 1)
    const result = v.safeParse(secretBindingsSchema, { [name]: key })
    if (!result.success) throw new Error('Invalid secret binding. Use ENV_NAME=secret.key with valid names.')
    if (Object.hasOwn(bindings, name)) throw new Error(`Duplicate secret environment name: ${name}`)
    bindings[name] = key
  }
  return bindings
}

export function secretBindingText(bindings: SecretBindings) {
  return Object.entries(bindings)
    .map(([name, key]) => `${name} ← ${key}`)
    .join(', ')
}

export class MissingSecretsError extends Error {
  constructor(readonly requirements: string[]) {
    super(`Required secrets are missing:\n${requirements.join('\n')}`)
    this.name = 'MissingSecretsError'
  }
}

// Never surface JSON/schema exceptions: they can contain the secret input itself.
function readSecrets(): Record<string, string> {
  let text: string
  try {
    text = readFileSync(getWoofHome(SECRETS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`Could not read ${SECRETS_FILE} in woof home.`, { cause: error })
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error(`Invalid JSON in ${SECRETS_FILE}. Correct the file locally without displaying its contents.`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${SECRETS_FILE} must contain an object of secret names and string values.`)
  for (const [key, secret] of Object.entries(value))
    if (!v.safeParse(secretKeySchema, key).success || typeof secret !== 'string' || secret.includes('\0'))
      throw new Error(
        `${SECRETS_FILE} contains an invalid entry. Use dotted names and string values without null bytes.`,
      )
  return value as Record<string, string>
}

/** Keeps reference checks and script execution on the same lazy snapshot. */
export function createSecretLookup() {
  let store: Record<string, string> | undefined
  return (key: string) => {
    store ??= readSecrets()
    const value = Object.hasOwn(store, key) ? store[key] : undefined
    if (value === undefined || value.length === 0) throw new MissingSecretsError([key])
    return value
  }
}

export function resolveSecretBindings(
  path: string,
  bindings: SecretBindings,
  lookup: ReturnType<typeof createSecretLookup>,
) {
  const env: NodeJS.ProcessEnv = {}
  const missing: string[] = []
  for (const [name, key] of Object.entries(bindings)) {
    try {
      env[name] = lookup(key)
    } catch (error) {
      if (!(error instanceof MissingSecretsError)) throw error
      missing.push(`${path}: ${name} ← ${key}`)
    }
  }
  if (missing.length) throw new MissingSecretsError(missing)
  return env
}
