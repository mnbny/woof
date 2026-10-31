import type { ConfigurationKind } from './config.ts'
import type { ProjectConfiguration, RootConfiguration } from './schema.ts'

import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { setTimeout } from 'node:timers/promises'

import { validateConfigurationDocument } from './config.ts'
import { CURRENT_SCHEMA_VERSION } from './schema.ts'

export class ConfigurationMigrationError extends Error {
  constructor(file: string, message: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options)
    this.name = 'ConfigurationMigrationError'
  }
}

export type ConfigurationMigrationInput = { file: string; kind?: ConfigurationKind }
export type PreparedConfigurationMigration = ReturnType<typeof prepareConfigurationMigration>

// Each key upgrades that schema version to the next.
const MIGRATIONS: Record<number, (config: Record<string, unknown>) => Record<string, unknown>> = {}

function isDictionary(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readVersion(config: Record<string, unknown>) {
  const version = config['$schemaVersion']
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    throw new Error('$schemaVersion must be a positive integer; no source version was inferred for migration.')
  return version
}

function unavailableMigration(file: string, version: number) {
  if (version > CURRENT_SCHEMA_VERSION)
    return new ConfigurationMigrationError(
      file,
      `$schemaVersion:${version} is newer than this CLI supports. Install a compatible Woof release; no downgrade or guessed migration was attempted.`,
    )
  return new ConfigurationMigrationError(
    file,
    `No migration is available from $schemaVersion:${version} to $schemaVersion:${CURRENT_SCHEMA_VERSION}. Use a compatible release or restore a supported configuration.`,
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
    return await action(target)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}

async function withConfigurationLocks<Result>(targets: string[], action: () => Result): Promise<Result> {
  const unique = [...new Set(targets)].sort()
  const [first, ...remaining] = unique
  if (!first) return action()
  return withConfigurationLock(first, () => withConfigurationLocks(remaining, action))
}

function prepareDocument({ file, kind = 'root' }: ConfigurationMigrationInput) {
  try {
    const target = realpathSync(file)
    const source = readFileSync(target, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(source)
    } catch (error) {
      throw new ConfigurationMigrationError(target, 'Configuration is not valid JSON.', { cause: error })
    }
    if (!isDictionary(parsed)) throw new ConfigurationMigrationError(target, 'Configuration must be an object.')

    const initial = readVersion(parsed)
    let config = parsed
    let current = initial
    while (current !== CURRENT_SCHEMA_VERSION) {
      const migrate = MIGRATIONS[current]
      if (!migrate) throw unavailableMigration(target, current)
      config = migrate(config)
      current = readVersion(config)
    }

    const migrated: RootConfiguration | ProjectConfiguration = validateConfigurationDocument(config, kind, target)
    return {
      file,
      target,
      kind,
      source,
      mode: statSync(target).mode,
      from: `$schemaVersion:${initial}`,
      changed: initial !== CURRENT_SCHEMA_VERSION,
      migrated,
    }
  } catch (error) {
    if (error instanceof ConfigurationMigrationError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ConfigurationMigrationError(file, message, { cause: error })
  }
}

export function prepareConfigurationMigration(documents: ConfigurationMigrationInput[]) {
  const prepared = documents.map(prepareDocument)
  const targets = new Set<string>()
  for (const document of prepared) {
    if (targets.has(document.target))
      throw new ConfigurationMigrationError(
        document.file,
        'The same physical configuration was supplied more than once.',
      )
    targets.add(document.target)
  }
  return { documents: prepared }
}

function serialized(document: PreparedConfigurationMigration['documents'][number]) {
  return `${JSON.stringify(document.migrated, null, 2)}\n`
}

function assertUnchanged(document: PreparedConfigurationMigration['documents'][number]) {
  if (readFileSync(document.target, 'utf8') !== document.source)
    throw new ConfigurationMigrationError(
      document.target,
      'Configuration changed during migration; retry without overwriting either version.',
    )
}

function restoreDocument(document: PreparedConfigurationMigration['documents'][number]) {
  const rollback = join(dirname(document.target), `.${basename(document.target)}.${randomUUID()}.rollback.tmp`)
  try {
    if (readFileSync(document.target, 'utf8') !== serialized(document))
      throw new Error('The migrated destination changed again before rollback.')
    writeFileSync(rollback, document.source, { flag: 'wx', mode: document.mode })
    chmodSync(rollback, document.mode & 0o7777)
    renameSync(rollback, document.target)
  } catch (error) {
    const recovery = join(dirname(document.target), `.${basename(document.target)}.${randomUUID()}.recovery.json`)
    try {
      writeFileSync(recovery, document.source, { flag: 'wx', mode: document.mode })
      chmodSync(recovery, document.mode & 0o7777)
    } catch (recoveryError) {
      throw new Error(`Could not restore ${document.target} or retain ${recovery}: ${String(recoveryError)}`, {
        cause: recoveryError,
      })
    }
    throw new Error(`Could not restore ${document.target}; original bytes were retained at ${recovery}.`, {
      cause: error,
    })
  } finally {
    rmSync(rollback, { force: true })
  }
}

export async function applyConfigurationMigration(plan: PreparedConfigurationMigration) {
  const changed = plan.documents.filter(document => document.changed)
  return withConfigurationLocks(
    plan.documents.map(document => document.target),
    () => {
      for (const document of plan.documents) assertUnchanged(document)

      const staged = changed.map(document => ({
        ...document,
        staging: join(dirname(document.target), `.${basename(document.target)}.${randomUUID()}.migration.tmp`),
      }))
      const cleanup = () => {
        for (const document of staged) rmSync(document.staging, { force: true })
      }

      try {
        for (const document of staged) {
          writeFileSync(document.staging, serialized(document), { flag: 'wx', mode: document.mode })
          chmodSync(document.staging, document.mode & 0o7777)
        }
        for (const document of plan.documents) assertUnchanged(document)
      } catch (error) {
        cleanup()
        const message = error instanceof Error ? error.message : String(error)
        throw new ConfigurationMigrationError(
          changed[0]?.file ?? 'configuration set',
          `Migration staging failed; no configuration was replaced. ${message}`,
          { cause: error },
        )
      }

      const applied: typeof staged = []
      try {
        for (const document of staged) {
          renameSync(document.staging, document.target)
          applied.push(document)
        }
      } catch (error) {
        const recoveryErrors: string[] = []
        for (const document of applied.reverse()) {
          try {
            restoreDocument(document)
          } catch (recoveryError) {
            recoveryErrors.push(recoveryError instanceof Error ? recoveryError.message : String(recoveryError))
          }
        }
        cleanup()
        const message = error instanceof Error ? error.message : String(error)
        throw new ConfigurationMigrationError(
          changed[0]?.file ?? 'configuration set',
          recoveryErrors.length
            ? `Migration failed and recovery is incomplete. ${recoveryErrors.join('; ')}`
            : `Migration failed; every replaced configuration was restored. ${message}`,
          { cause: error },
        )
      } finally {
        cleanup()
      }

      return staged.map(document => ({
        file: document.target,
        source: document.file,
        from: document.from,
        to: `$schemaVersion:${CURRENT_SCHEMA_VERSION}`,
      }))
    },
  )
}
