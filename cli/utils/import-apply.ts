import type { ImportSourceState, reviewImport } from './import-plan.ts'
import type { ProjectDefinition } from './projects.ts'

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { createBackupArchive, referencedResources } from './bundles.ts'
import { parseConfigurationDocument, serializeConfigurationDocument } from './config.ts'

export type ReviewedImportCandidate = Extract<ReturnType<typeof reviewImport>, { status: 'ready' }>['candidate']

export type ImportApplyReport = {
  completed: string[]
  restored: string[]
  pending: string[]
  recovery: string[]
  warnings: string[]
  backup?: string
}

export class ImportApplyError extends Error {
  readonly report: ImportApplyReport

  constructor(message: string, report: ImportApplyReport, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ImportApplyError'
    this.report = report
  }
}

type Change = {
  path: string
  data: Uint8Array
  original: Uint8Array | undefined
  originalDigest: string | null
  mode: number
  kind: 'resource' | 'project' | 'registry'
  target: string
}

type StagedChange = Change & {
  staging: string
  backup: string | undefined
}

function digest(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex')
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function safePath(path: string) {
  if (
    !path ||
    (sep === '\\' && path.includes('\\')) ||
    path.includes('\0') ||
    isAbsolute(path) ||
    (sep === '\\' && win32.isAbsolute(path)) ||
    path.split('/').some(segment => !segment || segment === '.' || segment === '..')
  )
    throw new Error(`Unsafe import destination: ${path}`)
}

function contained(root: string, file: string) {
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function readCurrent(home: string, path: string): Uint8Array | undefined {
  safePath(path)
  const file = resolve(home, path)
  try {
    if (path !== 'woof.config.json' && !contained(realpathSync(home), realpathSync(file)))
      throw new Error(`Import destination escapes the woof home: ${path}`)
    if (!statSync(file).isFile()) throw new Error(`Import destination is not a regular file: ${path}`)
    return readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function currentDigest(home: string, source: ImportSourceState) {
  const data = readCurrent(home, source.path)
  const actual = data ? digest(data) : null
  const physical = inspectWriteDestination(home, source.path).target
  if (actual !== source.digest || physical !== source.physical)
    throw new Error(`Import destination ${source.path} changed after review; stale decisions were not applied.`)
  return data
}

export function inspectWriteDestination(home: string, path: string) {
  safePath(path)
  const physicalHome = realpathSync(home)
  const logical = resolve(physicalHome, path)
  let current = physicalHome
  const segments = path.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) {
        try {
          current = realpathSync(current)
        } catch (error) {
          throw new Error(`Import destination has an unresolved symbolic link: ${current}`, { cause: error })
        }
        if (!(path === 'woof.config.json' && index === segments.length - 1) && !contained(physicalHome, current))
          throw new Error(`Import destination escapes the woof home: ${path}`)
      }
      const resolved = statSync(current)
      if (index === segments.length - 1 && !resolved.isFile())
        throw new Error(`Import destination is not a regular file: ${path}`)
      if (index < segments.length - 1 && !resolved.isDirectory())
        throw new Error(`Import destination parent is not a directory: ${path}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const target = resolve(current, ...segments.slice(index + 1))
      if (!contained(physicalHome, target))
        throw new Error(`Import destination escapes the woof home: ${path}`, { cause: error })
      return { target, mode: 0o600 }
    }
  }
  if (path !== 'woof.config.json' && !contained(physicalHome, current))
    throw new Error(`Import destination escapes the woof home: ${path}`)
  return { target: current, mode: statSync(logical).mode & 0o7777 }
}

function serialized(value: unknown) {
  return new TextEncoder().encode(serializeConfigurationDocument(value))
}

function changes(candidate: ReviewedImportCandidate, current: ReadonlyMap<string, Uint8Array | undefined>) {
  const changes: Change[] = []
  for (const [path, data] of [...candidate.files].sort(([left], [right]) => left.localeCompare(right))) {
    const source = candidate.sources.find(source => source.path === path)
    if (!source) throw new Error(`Reviewed source state is missing for ${path}.`)
    const original = current.get(path)
    if (original && equalBytes(original, data)) continue
    const destination = inspectWriteDestination(candidate.home, path)
    changes.push({
      path,
      data,
      original,
      originalDigest: source.digest,
      mode: destination.mode,
      target: destination.target,
      kind: 'resource',
    })
  }
  if (candidate.projectFile) {
    const { path, data } = candidate.projectFile
    const original = current.get(path)
    const finalBytes = serialized(data)
    const unchanged =
      (candidate.initialProject?.path === path && isDeepStrictEqual(candidate.initialProject.data, data)) ||
      (original && equalBytes(original, finalBytes))
    if (!unchanged) {
      const source = candidate.sources.find(source => source.path === path)
      if (!source) throw new Error(`Reviewed project source state is missing for ${path}.`)
      const destination = inspectWriteDestination(candidate.home, path)
      changes.push({
        path,
        data: finalBytes,
        original,
        originalDigest: source.digest,
        mode: destination.mode,
        target: destination.target,
        kind: 'project',
      })
    }
  }
  if (!isDeepStrictEqual(candidate.local, candidate.configuration)) {
    const path = 'woof.config.json'
    const source = candidate.sources.find(source => source.path === path)
    if (!source) throw new Error('Reviewed root source state is missing.')
    const original = current.get(path)
    const destination = inspectWriteDestination(candidate.home, path)
    changes.push({
      path,
      data: serialized(candidate.configuration),
      original,
      originalDigest: source.digest,
      mode: destination.mode,
      target: destination.target,
      kind: 'registry',
    })
  }
  const unique = new Map<string, Change>()
  for (const change of changes) {
    const previous = unique.get(change.target)
    if (previous && !equalBytes(previous.data, change.data))
      throw new Error(`Import paths ${previous.path} and ${change.path} require conflicting writes to the same file.`)
    if (!previous) unique.set(change.target, change)
  }
  return [...unique.values()]
}

function parentDirectories(home: string, path: string) {
  const physicalHome = realpathSync(home)
  const target = resolve(physicalHome, path)
  const parent = dirname(target)
  const missing: string[] = []
  let current = parent
  while (current !== physicalHome) {
    if (!contained(physicalHome, current)) throw new Error(`Import parent escapes the woof home: ${path}`)
    try {
      if (!statSync(current).isDirectory()) throw new Error(`Import parent is not a directory: ${current}`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.unshift(current)
      current = dirname(current)
    }
  }
  return missing
}

function writeExact(path: string, data: Uint8Array, mode: number) {
  writeFileSync(path, data, { flag: 'wx', mode })
  chmodSync(path, mode)
}

function cleanupPaths(paths: Iterable<string>) {
  const warnings: string[] = []
  for (const path of paths) {
    try {
      rmSync(path, { force: true })
    } catch (error) {
      warnings.push(
        `Could not remove temporary artifact ${path}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return warnings
}

function cleanupDirectories(directories: string[]) {
  const warnings: string[] = []
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    try {
      rmdirSync(directory)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT') continue
      warnings.push(
        `Could not remove empty import directory ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return warnings
}

function temporaryArtifacts(target: string, kind: 'stage' | 'backup') {
  return join(dirname(target), `.${basename(target)}.woof-import-${kind}-${randomUUID()}.tmp`)
}

function report(
  completed: string[],
  restored: string[],
  pending: string[],
  recovery: string[] = [],
  warnings: string[] = [],
  backup?: string,
): ImportApplyReport {
  return { completed, restored, pending, recovery, warnings, ...(backup ? { backup } : {}) }
}

// Rollback covers a failed write only. The archive keeps the state before the import, so a successful import can
// still be undone: it holds the configuration, every file the configuration references, and every replaced file.
function writeBackup(candidate: ReviewedImportCandidate, planned: Change[]) {
  const files = new Map<string, Uint8Array>()
  const add = (path: string) => {
    if (files.has(path)) return
    const data = readCurrent(candidate.home, path)
    if (data) files.set(path, data)
  }
  add('woof.config.json')
  const projects: ProjectDefinition[] = []
  for (const definition of Object.values(candidate.local.$projects ?? {})) {
    if (typeof definition !== 'string') {
      projects.push(definition)
      continue
    }
    const path = definition.slice('<root>/'.length)
    add(path)
    const data = files.get(path)
    if (data) projects.push(parseConfigurationDocument(new TextDecoder().decode(data), 'project', path))
  }
  for (const reference of referencedResources(candidate.local, ...projects))
    if (reference.startsWith('<root>/')) add(reference.slice('<root>/'.length))
  for (const change of planned) if (change.original) files.set(change.path, change.original)

  const archive = createBackupArchive(
    [...files].sort(([left], [right]) => left.localeCompare(right)).map(([path, data]) => ({ path, data })),
  )
  const directory = join(candidate.home, '.backups')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replaceAll(':', '-')
  for (let attempt = 1; ; attempt += 1) {
    const file = join(directory, `import-${stamp}${attempt === 1 ? '' : `-${attempt}`}.zip`)
    try {
      writeExact(file, archive, 0o600)
      return file
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      rmSync(file, { force: true })
      throw error
    }
  }
}

export function applyImport(candidate: ReviewedImportCandidate) {
  const current = new Map<string, Uint8Array | undefined>()
  for (const source of candidate.sources) current.set(source.path, currentDigest(candidate.home, source))
  for (const source of candidate.externalSources)
    if (digest(readFileSync(source.path)) !== source.digest)
      throw new Error(`Reuse source ${source.path} changed after review.`)
  const planned = changes(candidate, current)
  if (!planned.length) return report([], [], [])

  let backup: string
  try {
    backup = writeBackup(candidate, planned)
  } catch (error) {
    throw new ImportApplyError(
      `Import backup failed before any change: ${error instanceof Error ? error.message : String(error)}`,
      report(
        [],
        [],
        planned.map(change => change.path),
      ),
      { cause: error },
    )
  }

  const createdDirectories: string[] = []
  const staged: StagedChange[] = []
  try {
    for (const change of planned) {
      for (const directory of parentDirectories(candidate.home, change.path)) {
        mkdirSync(directory)
        createdDirectories.push(directory)
      }
      const staging = temporaryArtifacts(change.target, 'stage')
      const stagedChange: StagedChange = { ...change, staging, backup: undefined }
      staged.push(stagedChange)
      writeExact(staging, change.data, change.mode)
      if (change.original) {
        const backup = temporaryArtifacts(change.target, 'backup')
        stagedChange.backup = backup
        writeExact(backup, change.original, change.mode)
      }
    }
    for (const source of candidate.sources) currentDigest(candidate.home, source)
    for (const source of candidate.externalSources)
      if (digest(readFileSync(source.path)) !== source.digest)
        throw new Error(`Reuse source ${source.path} changed after review.`)
  } catch (error) {
    const warnings = [
      ...cleanupPaths(staged.flatMap(change => [change.staging, ...(change.backup ? [change.backup] : [])])),
      ...cleanupDirectories(createdDirectories),
    ]
    throw new ImportApplyError(
      `Import staging failed before any live replacement: ${error instanceof Error ? error.message : String(error)}`,
      report(
        [],
        [],
        planned.map(change => change.path),
        [],
        warnings,
        backup,
      ),
      { cause: error },
    )
  }

  const completed: StagedChange[] = []
  try {
    for (const change of staged) {
      const actual = readCurrent(candidate.home, change.path)
      const actualDigest = actual ? digest(actual) : null
      if (actualDigest !== change.originalDigest)
        throw new Error(
          `Import destination ${change.path} changed before replacement; stale decisions were not applied.`,
        )
      if (inspectWriteDestination(candidate.home, change.path).target !== change.target)
        throw new Error(`Import destination ${change.path} changed location before replacement.`)
      renameSync(change.staging, change.target)
      completed.push(change)
    }
  } catch (error) {
    const restored: string[] = []
    const recovery: string[] = []
    const rollbackErrors: string[] = []
    for (const change of [...completed].reverse()) {
      try {
        const target = change.target
        if (inspectWriteDestination(candidate.home, change.path).target !== target)
          throw new Error(`Import destination ${change.path} changed location before rollback.`, { cause: error })
        const actual = readCurrent(candidate.home, change.path)
        if (!actual || !equalBytes(actual, change.data)) {
          if (change.backup) recovery.push(change.backup)
          rollbackErrors.push(`${change.path} changed after replacement and was not overwritten during rollback.`)
          continue
        }
        if (change.original) {
          renameSync(change.backup!, target)
        } else {
          rmSync(target)
        }
        restored.push(change.path)
      } catch (rollbackError) {
        if (change.backup) recovery.push(change.backup)
        rollbackErrors.push(
          `${change.path} could not be restored: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        )
      }
    }
    const appliedBackups = new Set(completed.map(change => change.backup).filter(Boolean))
    const unnecessaryBackups = staged
      .filter(change => !appliedBackups.has(change.backup) && change.backup)
      .map(change => change.backup!)
    const warnings = [
      ...cleanupPaths([...staged.map(change => change.staging), ...unnecessaryBackups]),
      ...cleanupDirectories(createdDirectories),
    ]
    const pending = staged.filter(change => !completed.includes(change)).map(change => change.path)
    throw new ImportApplyError(
      `Import failed: ${error instanceof Error ? error.message : String(error)}. ${rollbackErrors.join(' ')}`,
      report(
        completed.map(change => change.path),
        restored,
        pending,
        [...new Set(recovery)],
        [...warnings, ...rollbackErrors],
        backup,
      ),
      { cause: error },
    )
  }

  const warnings = cleanupPaths(staged.flatMap(change => [change.staging, ...(change.backup ? [change.backup] : [])]))
  return report(
    completed.map(change => change.path),
    [],
    [],
    staged
      .filter(change => change.backup && warnings.some(warning => warning.includes(change.backup!)))
      .map(change => change.backup!),
    warnings,
    backup,
  )
}
