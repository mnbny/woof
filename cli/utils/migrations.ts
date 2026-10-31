import type { ConfigurationKind } from './config.ts'

import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { validateConfigurationDocument } from './config.ts'
import { getWoofHome } from './paths.ts'
import { CURRENT_SCHEMA_VERSION } from './schema.ts'

export class ConfigurationMigrationError extends Error {
  constructor(file: string, message: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options)
    this.name = 'ConfigurationMigrationError'
  }
}

const MIGRATIONS: Record<string, (config: Record<string, unknown>) => Record<string, unknown>> = {
  'legacy:1': config => {
    if (Object.keys(config).length !== 1 || config['schemaVersion'] !== 1)
      throw new Error('The legacy scaffold must contain only schemaVersion:1; its content was not guessed or migrated.')
    return { $schemaVersion: CURRENT_SCHEMA_VERSION }
  },
}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function identifyVersion(config: Record<string, unknown>) {
  const product = Object.prototype.hasOwnProperty.call(config, '$schemaVersion')
  const legacy = Object.prototype.hasOwnProperty.call(config, 'schemaVersion')
  if (product === legacy)
    throw new Error(
      'Configuration must have exactly one recognized version field; no source version was inferred for migration.',
    )
  const family = product ? 'product' : 'legacy'
  const field = product ? '$schemaVersion' : 'schemaVersion'
  const version = config[field]
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error(`${field} must be a positive integer; no source version was inferred for migration.`)
  return { family, field, version }
}

function unavailableMigration(file: string, field: string, version: number) {
  if (version > CURRENT_SCHEMA_VERSION)
    return new ConfigurationMigrationError(
      file,
      `${field}:${version} is newer than this CLI supports. Install a compatible Woof release; no downgrade or guessed migration was attempted.`,
    )
  return new ConfigurationMigrationError(
    file,
    `No migration is available from ${field}:${version} to $schemaVersion:${CURRENT_SCHEMA_VERSION}. Use a compatible release or restore a supported configuration.`,
  )
}

export async function withConfigurationLock<Result>(file: string, action: (target: string) => Result) {
  const target = realpathSync(file)
  const lock = join(dirname(target), `.${basename(target)}.woof-migration.lock`)
  const deadline = Date.now() + 5_000

  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (Date.now() >= deadline) throw new Error(`Configuration lock timed out: ${lock}`, { cause: error })
      await setTimeout(20)
    }
  }

  try {
    return action(target)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

export async function migrateConfigurationDocument(
  file = getWoofHome('woof.config.json'),
  kind: ConfigurationKind = 'root',
) {
  try {
    return await withConfigurationLock(file, target => {
      const source = readFileSync(target, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(source)
      } catch (error) {
        throw new ConfigurationMigrationError(target, 'Configuration is not valid JSON.', { cause: error })
      }
      if (!isDictionary(parsed)) throw new ConfigurationMigrationError(target, 'Configuration must be an object.')

      const initial = identifyVersion(parsed)
      if (initial.family === 'product' && initial.version === CURRENT_SCHEMA_VERSION) {
        validateConfigurationDocument(parsed, kind, target)
        return undefined
      }
      if (initial.family === 'legacy' && kind !== 'root')
        throw unavailableMigration(target, initial.field, initial.version)

      let config = parsed
      let current = initial
      const from = `${initial.field}:${initial.version}`
      while (current.family !== 'product' || current.version !== CURRENT_SCHEMA_VERSION) {
        const migrate = MIGRATIONS[`${current.family}:${current.version}`]
        if (!migrate) throw unavailableMigration(target, current.field, current.version)
        config = migrate(config)
        current = identifyVersion(config)
      }

      const migrated = validateConfigurationDocument(config, kind, target)
      const staging = join(dirname(target), `.${basename(target)}.${randomUUID()}.migration.tmp`)
      try {
        writeFileSync(staging, `${JSON.stringify(migrated, null, 2)}\n`, { flag: 'wx', mode: statSync(target).mode })
        if (readFileSync(target, 'utf8') !== source)
          throw new ConfigurationMigrationError(
            target,
            'Configuration changed during migration; retry without overwriting either version.',
          )
        renameSync(staging, target)
      } finally {
        rmSync(staging, { force: true })
      }
      return { file: target, from, to: `$schemaVersion:${CURRENT_SCHEMA_VERSION}` }
    })
  } catch (error) {
    if (error instanceof ConfigurationMigrationError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigurationMigrationError(file, message, { cause: error })
  }
}
