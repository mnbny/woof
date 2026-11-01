import type { ConfigurationKind } from './config.ts'
import type { ProjectConfiguration, RootConfiguration } from './schema.ts'

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'

import { readConfigurationDocument } from './config.ts'
import { getWoofHome } from './paths.ts'

export type ResourceRootKind = 'root' | 'repo'
export type ResourceLocation = {
  file: string
  root: string
  rootKind: ResourceRootKind
  markedPath: string
}
export type ConfigurationSource = ResourceLocation & { kind: ConfigurationKind }

export class ResourceLoadError extends Error {
  readonly reference: string
  readonly detail: string

  constructor(reference: string, detail: string, options?: ErrorOptions) {
    super(`Could not load ${reference}: ${detail}`, options)
    this.name = 'ResourceLoadError'
    this.reference = reference
    this.detail = detail
  }
}

// A missing file is the common case, so it reads plainly.
function failure(error: unknown) {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'the file does not exist.'
  return error instanceof Error ? error.message : String(error)
}

export function detectCheckoutRoot(cwd = process.cwd()) {
  try {
    const root = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return root ? realpathSync(root) : undefined
  } catch {
    return undefined
  }
}

export function isMarkedResourceReference(reference: string) {
  return reference.startsWith('<root>/') || reference.startsWith('<repo>/')
}

function contained(root: string, file: string) {
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function physicalFile(root: string, candidate: string, reference: string) {
  try {
    const physicalRoot = realpathSync(root)
    const file = realpathSync(candidate)
    if (!contained(physicalRoot, file))
      throw new ResourceLoadError(reference, 'the resolved path escapes its declared root.')
    if (!statSync(file).isFile()) throw new ResourceLoadError(reference, 'the marked resource is not a regular file.')
    return { file, root: physicalRoot }
  } catch (error) {
    if (error instanceof ResourceLoadError) throw error
    throw new ResourceLoadError(reference, failure(error), { cause: error })
  }
}

function markedLocation(reference: string, repoRoot: string | undefined): ResourceLocation {
  const rootKind = reference.startsWith('<root>/') ? 'root' : reference.startsWith('<repo>/') ? 'repo' : undefined
  if (!rootKind) throw new ResourceLoadError(reference, 'expected a path beginning with <root>/ or <repo>/.')
  if (rootKind === 'repo' && !repoRoot)
    throw new ResourceLoadError(
      reference,
      'no active checkout or worktree supplies <repo>; there is no filesystem fallback.',
    )
  const markedRoot = rootKind === 'root' ? getWoofHome() : repoRoot!
  const markedPath = reference.slice(rootKind === 'root' ? '<root>/'.length : '<repo>/'.length)
  if (
    !markedPath ||
    (sep === '\\' && markedPath.includes('\\')) ||
    markedPath.includes('\0') ||
    isAbsolute(markedPath) ||
    (sep === '\\' && win32.isAbsolute(markedPath)) ||
    markedPath.split('/').some(segment => !segment || segment === '.' || segment === '..')
  )
    throw new ResourceLoadError(
      reference,
      'the marked path contains an absolute, empty, backslash or traversal component.',
    )
  const { file, root } = physicalFile(markedRoot, resolve(markedRoot, markedPath), reference)
  return { file, root, rootKind, markedPath: reference }
}

function directLocation(file: string, rootKind: ResourceRootKind, repoRoot: string | undefined): ResourceLocation {
  const markedRoot = rootKind === 'root' ? getWoofHome() : repoRoot
  if (!markedRoot) throw new ResourceLoadError(file, 'no active checkout or worktree supplies the configuration root.')
  try {
    const root = realpathSync(markedRoot)
    const physical = realpathSync(resolve(markedRoot, file))
    if (!statSync(physical).isFile()) throw new ResourceLoadError(file, 'the configuration is not a regular file.')
    return { file: physical, root, rootKind, markedPath: file }
  } catch (error) {
    if (error instanceof ResourceLoadError) throw error
    throw new ResourceLoadError(file, failure(error), { cause: error })
  }
}

export function resolveResourceLocation(reference: string, options: { cwd?: string; repoRoot?: string } = {}) {
  return markedLocation(reference, options.repoRoot ?? detectCheckoutRoot(options.cwd))
}

export function readMarkedResource(reference: string, options: { cwd?: string; repoRoot?: string } = {}) {
  const provenance = resolveResourceLocation(reference, options)
  return { content: readFileSync(provenance.file, 'utf8'), provenance }
}

export function createResourceLoader(options: { cwd?: string; repoRoot?: string } = {}) {
  const repoRoot = options.repoRoot ?? detectCheckoutRoot(options.cwd)
  const cache = new Map<string, { data: RootConfiguration | ProjectConfiguration; source: ConfigurationSource }>()
  const active: string[] = []

  function loadConfiguration(reference: string, kind: ConfigurationKind, rootKind?: ResourceRootKind) {
    const location = rootKind ? directLocation(reference, rootKind, repoRoot) : markedLocation(reference, repoRoot)
    if (active.includes(location.file) || (kind !== 'root' && cache.has(`root:${location.file}`)))
      throw new ResourceLoadError(
        reference,
        `configuration-reference cycle: ${[...active, location.file].join(' -> ')}`,
      )
    const cacheKey = `${kind}:${location.file}`
    const cached = cache.get(cacheKey)
    if (cached) return cached

    active.push(location.file)
    try {
      const data =
        kind === 'root'
          ? readConfigurationDocument(location.file, kind)
          : readConfigurationDocument(location.file, kind)
      const loaded = { data, source: { ...location, kind } }
      cache.set(cacheKey, loaded)
      return loaded
    } finally {
      active.pop()
    }
  }

  return {
    repoRoot,
    loadRootConfiguration(file = getWoofHome('woof.config.json')) {
      return loadConfiguration(file, 'root', 'root') as {
        data: RootConfiguration
        source: ConfigurationSource
      }
    },
    loadProjectConfiguration(reference: string) {
      return loadConfiguration(reference, 'project') as {
        data: ProjectConfiguration
        source: ConfigurationSource
      }
    },
    loadRepositoryConfiguration(file: string) {
      if (!repoRoot) throw new ResourceLoadError(file, 'no active checkout or worktree supplies <repo>.')
      return loadConfiguration(file, 'repository', 'repo') as {
        data: ProjectConfiguration
        source: ConfigurationSource
      }
    },
    readResource(reference: string) {
      const provenance = markedLocation(reference, repoRoot)
      return { content: readFileSync(provenance.file, 'utf8'), provenance }
    },
  }
}
