import type { ProjectConfiguration, RootConfiguration } from './schema.ts'

import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import * as v from 'valibot'

import { CURRENT_SCHEMA_VERSION, projectConfigurationSchema, rootConfigurationSchema } from './schema.ts'

/** A repository configuration is a project document without metadata, because its checkout already selects it. */
export type ConfigurationKind = 'root' | 'project' | 'repository'

export class ConfigurationVersionError extends Error {
  readonly actual: unknown
  readonly reason: 'missing' | 'mismatch'

  constructor(source: string, reason: 'missing' | 'mismatch', actual?: unknown) {
    const message =
      reason === 'missing'
        ? `Configuration at ${source} requires an explicit $schemaVersion of ${CURRENT_SCHEMA_VERSION}.`
        : `Configuration at ${source} uses unsupported $schemaVersion ${JSON.stringify(actual)}; expected ${CURRENT_SCHEMA_VERSION}. Explicit migration is required.`
    super(message)
    this.name = 'ConfigurationVersionError'
    this.actual = actual
    this.reason = reason
  }
}

export class ConfigurationSyntaxError extends Error {
  constructor(source: string, options: ErrorOptions) {
    super(`Could not parse configuration at ${source} as JSON.`, options)
    this.name = 'ConfigurationSyntaxError'
  }
}

export class ConfigurationShapeError extends Error {
  constructor(source: string, detail: string) {
    super(`Invalid configuration at ${source}: ${detail}`)
    this.name = 'ConfigurationShapeError'
  }
}

export class ConfigurationReadError extends Error {
  readonly file: string

  constructor(file: string, options: ErrorOptions) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause)
    super(`Could not read configuration at ${file}: ${detail}`, options)
    this.name = 'ConfigurationReadError'
    this.file = file
  }
}

export class ConfigurationNotFoundError extends ConfigurationReadError {
  constructor(file: string, options: ErrorOptions) {
    super(file, options)
    this.name = 'ConfigurationNotFoundError'
  }
}

const dangerousNames = new Set(['__proto__', 'prototype', 'constructor'])
const resourceKeys = new Set(['$type', '$exec', '$description', '$tags'])
const metadataKeys = new Set(['$basePaths', '$worktreePaths'])

function isDictionary(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function childPath(path: string, key: string) {
  return path ? `${path}.${key}` : key
}

function assertTokenName(name: string, path: string, source: string) {
  if (dangerousNames.has(name))
    throw new ConfigurationShapeError(source, `${path} uses a prototype-sensitive name, which is not supported.`)
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    throw new ConfigurationShapeError(
      source,
      `${path} must contain only ASCII letters, digits, underscores and hyphens.`,
    )
}

function assertTokenValue(value: unknown, path: string, source: string) {
  if (!isDictionary(value)) return
  if (hasOwn(value, '$type') || hasOwn(value, '$exec')) {
    for (const key of Object.keys(value))
      if (!resourceKeys.has(key))
        throw new ConfigurationShapeError(source, `${childPath(path, key)} is not a supported resource field.`)
    return
  }
  assertTokenNamespace(value, path, source)
}

function assertTokenNamespace(namespace: Record<string, unknown>, path: string, source: string) {
  for (const [key, value] of Object.entries(namespace)) {
    const currentPath = childPath(path, key)
    if (key.startsWith('$')) throw new ConfigurationShapeError(source, `${currentPath} is an unknown reserved field.`)
    assertTokenName(key, currentPath, source)
    assertTokenValue(value, currentPath, source)
  }
}

function assertMetadata(metadata: Record<string, unknown>, path: string, source: string) {
  for (const key of Object.keys(metadata))
    if (!metadataKeys.has(key))
      throw new ConfigurationShapeError(source, `${childPath(path, key)} is not a supported metadata field.`)
}

function assertInlineProject(project: Record<string, unknown>, path: string, source: string) {
  for (const [key, value] of Object.entries(project)) {
    const currentPath = childPath(path, key)
    if (key === '$metadata') {
      if (isDictionary(value)) assertMetadata(value, currentPath, source)
      continue
    }
    if (key.startsWith('$'))
      throw new ConfigurationShapeError(source, `${currentPath} is not valid in an inline project.`)
    assertTokenName(key, currentPath, source)
    assertTokenValue(value, currentPath, source)
  }
}

function assertDocumentKeys(value: Record<string, unknown>, kind: ConfigurationKind, source: string) {
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$schemaVersion') continue
    if (kind === 'root' && key === '$projects') {
      if (isDictionary(entry))
        for (const [name, project] of Object.entries(entry)) {
          const path = childPath('$projects', name)
          assertTokenName(name, path, source)
          if (typeof project === 'string' && !project.startsWith('<root>/'))
            throw new ConfigurationShapeError(
              source,
              `${path} must be inline or reference a <root>/ configuration file.`,
            )
          if (isDictionary(project)) assertInlineProject(project, path, source)
        }
      continue
    }
    if (kind === 'project' && key === '$metadata') {
      if (isDictionary(entry)) assertMetadata(entry, key, source)
      continue
    }
    if (kind === 'repository' && key === '$metadata')
      throw new ConfigurationShapeError(
        source,
        '$metadata is not valid in repository configuration. The checkout selects it, so it takes no paths.',
      )
    if (key.startsWith('$')) throw new ConfigurationShapeError(source, `${key} is not valid in ${kind} configuration.`)
    assertTokenName(key, key, source)
    assertTokenValue(entry, key, source)
  }
}

export function validateConfigurationDocument(value: unknown, kind: 'root', source?: string): RootConfiguration
export function validateConfigurationDocument(
  value: unknown,
  kind: 'project' | 'repository',
  source?: string,
): ProjectConfiguration
export function validateConfigurationDocument(
  value: unknown,
  kind: ConfigurationKind,
  source?: string,
): RootConfiguration | ProjectConfiguration
export function validateConfigurationDocument(value: unknown, kind: ConfigurationKind, source = '<configuration>') {
  if (isDictionary(value)) {
    if (!hasOwn(value, '$schemaVersion')) throw new ConfigurationVersionError(source, 'missing')
    if (value['$schemaVersion'] !== CURRENT_SCHEMA_VERSION)
      throw new ConfigurationVersionError(source, 'mismatch', value['$schemaVersion'])
    assertDocumentKeys(value, kind, source)
  }

  const result = v.safeParse(kind === 'root' ? rootConfigurationSchema : projectConfigurationSchema, value)
  if (!result.success) {
    const detail = result.issues
      .map(issue => {
        const path = issue.path?.map(item => String(item.key)).join('.')
        return path ? `${path}: ${issue.message}` : issue.message
      })
      .join('; ')
    throw new ConfigurationShapeError(source, detail)
  }
  return result.output
}

export function parseConfigurationDocument(text: string, kind: 'root', source?: string): RootConfiguration
export function parseConfigurationDocument(
  text: string,
  kind: 'project' | 'repository',
  source?: string,
): ProjectConfiguration
export function parseConfigurationDocument(text: string, kind: ConfigurationKind, source = '<configuration>') {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new ConfigurationSyntaxError(source, { cause: error })
  }
  return kind === 'root'
    ? validateConfigurationDocument(value, kind, source)
    : validateConfigurationDocument(value, kind, source)
}

export function readConfigurationDocument(file: string, kind: 'root'): RootConfiguration
export function readConfigurationDocument(file: string, kind: 'project' | 'repository'): ProjectConfiguration
export function readConfigurationDocument(file: string, kind: ConfigurationKind) {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    const options = { cause: error }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ConfigurationNotFoundError(file, options)
    throw new ConfigurationReadError(file, options)
  }
  return kind === 'root' ? parseConfigurationDocument(text, kind, file) : parseConfigurationDocument(text, kind, file)
}

/** Writing a staged copy and renaming it replaces the file in one step and keeps its mode. */
export function replaceFileContent(target: string, content: string | Uint8Array) {
  const staging = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  const { mode } = statSync(target)
  try {
    writeFileSync(staging, content, { flag: 'wx', mode })
    chmodSync(staging, mode & 0o7777)
    renameSync(staging, target)
  } finally {
    rmSync(staging, { force: true })
  }
}

export function replaceConfigurationFile(target: string, value: unknown) {
  replaceFileContent(target, `${JSON.stringify(value, null, 2)}\n`)
}
