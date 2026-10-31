import type { ImportSourceState, reviewImport } from './import-plan.ts'

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

export type ReviewedImportCandidate = Extract<ReturnType<typeof reviewImport>, { status: 'ready' }>['candidate']

export type ImportApplyReport = {
  completed: string[]
  restored: string[]
  pending: string[]
  recovery: string[]
  warnings: string[]
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
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
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
      throw new Error(`Import destination escapes the Woof home: ${path}`)
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
  if (actual !== source.digest)
    throw new Error(`Import destination ${source.path} changed after review; stale decisions were not applied.`)
  return data
}

function inspectWriteDestination(home: string, path: string) {
  safePath(path)
  const physicalHome = realpathSync(home)
  const target = resolve(physicalHome, path)
  if (!contained(physicalHome, target)) throw new Error(`Import destination escapes the Woof home: ${path}`)
  const segments = path.split('/')
  let current = physicalHome
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]!)
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`Import destination contains a symbolic link: ${current}`)
      if (index === segments.length - 1 && !stat.isFile())
        throw new Error(`Import destination is not a regular file: ${current}`)
      if (index < segments.length - 1 && !stat.isDirectory())
        throw new Error(`Import destination parent is not a directory: ${current}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (index < segments.length - 1) continue
        return { target, mode: 0o600 }
      }
      throw error
    }
  }
  return { target, mode: statSync(target).mode & 0o7777 }
}

function serialized(value: unknown) {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)
}

function changes(candidate: ReviewedImportCandidate, current: ReadonlyMap<string, Uint8Array | undefined>) {
  const changes: Change[] = []
  for (const [path, data] of [...candidate.files].sort(([left], [right]) => left.localeCompare(right))) {
    const source = candidate.sources.find(source => source.path === path)
    if (!source) throw new Error(`Reviewed source state is missing for ${path}.`)
    const original = current.get(path)
    if (original && equalBytes(original, data)) continue
    const destination = inspectWriteDestination(candidate.home, path)
    changes.push({ path, data, original, originalDigest: source.digest, mode: destination.mode, kind: 'resource' })
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
      kind: 'registry',
    })
  }
  return changes
}

function parentDirectories(home: string, path: string) {
  const physicalHome = realpathSync(home)
  const target = resolve(physicalHome, path)
  const parent = dirname(target)
  const missing: string[] = []
  let current = parent
  while (current !== physicalHome) {
    if (!contained(physicalHome, current)) throw new Error(`Import parent escapes the Woof home: ${path}`)
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

function temporaryArtifacts(home: string, path: string, kind: 'stage' | 'backup') {
  const target = resolve(home, path)
  return join(dirname(target), `.${basename(target)}.woof-import-${kind}-${randomUUID()}.tmp`)
}

function report(
  completed: string[],
  restored: string[],
  pending: string[],
  recovery: string[] = [],
  warnings: string[] = [],
) {
  return { completed, restored, pending, recovery, warnings }
}

export function applyImport(candidate: ReviewedImportCandidate) {
  const current = new Map<string, Uint8Array | undefined>()
  for (const source of candidate.sources) current.set(source.path, currentDigest(candidate.home, source))
  const planned = changes(candidate, current)
  if (!planned.length) return { ...report([], [], []), deferredRequirements: candidate.deferredRequirements }

  const createdDirectories: string[] = []
  const staged: StagedChange[] = []
  try {
    for (const change of planned) {
      for (const directory of parentDirectories(candidate.home, change.path)) {
        mkdirSync(directory)
        createdDirectories.push(directory)
      }
      const staging = temporaryArtifacts(candidate.home, change.path, 'stage')
      const stagedChange: StagedChange = { ...change, staging, backup: undefined }
      staged.push(stagedChange)
      writeExact(staging, change.data, change.mode)
      if (change.original) {
        const backup = temporaryArtifacts(candidate.home, change.path, 'backup')
        stagedChange.backup = backup
        writeExact(backup, change.original, change.mode)
      }
    }
    for (const source of candidate.sources) currentDigest(candidate.home, source)
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
      inspectWriteDestination(candidate.home, change.path)
      renameSync(change.staging, resolve(candidate.home, change.path))
      completed.push(change)
    }
  } catch (error) {
    const restored: string[] = []
    const recovery: string[] = []
    const rollbackErrors: string[] = []
    for (const change of [...completed].reverse()) {
      try {
        const target = resolve(candidate.home, change.path)
        inspectWriteDestination(candidate.home, change.path)
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
      ),
      { cause: error },
    )
  }

  const warnings = cleanupPaths(staged.flatMap(change => [change.staging, ...(change.backup ? [change.backup] : [])]))
  return {
    ...report(
      completed.map(change => change.path),
      [],
      [],
      staged
        .filter(change => change.backup && warnings.some(warning => warning.includes(change.backup!)))
        .map(change => change.backup!),
      warnings,
    ),
    deferredRequirements: candidate.deferredRequirements,
  }
}
