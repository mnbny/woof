import type { ConfigurationSource } from './resources.ts'
import type { InlineProject, ProjectConfiguration, RootConfiguration } from './schema.ts'

import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep, win32 } from 'node:path'
import picomatch from 'picomatch'

import { getWoofHome } from './paths.ts'
import { createResourceLoader, detectCheckoutRoot } from './resources.ts'

type ResourceLoader = ReturnType<typeof createResourceLoader>

export type ProjectDefinition = InlineProject | ProjectConfiguration
export type RegisteredProject = {
  kind: 'registered'
  name: string
  data: ProjectDefinition
  source: ConfigurationSource
  inline: boolean
}
export type RepositoryProject = {
  kind: 'repository'
  name: undefined
  data: ProjectConfiguration
  source: ConfigurationSource
  inline: false
}
export type LoadedRoot = { data: RootConfiguration; source: ConfigurationSource }

export class ProjectSelectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ProjectSelectionError'
  }
}

function contained(root: string, file: string) {
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export function insideWoofHome(cwd: string) {
  try {
    return contained(realpathSync(getWoofHome()), realpathSync(cwd))
  } catch {
    return false
  }
}

export function repositoryConfiguration(checkoutRoot: string) {
  const candidates = [
    resolve(checkoutRoot, 'woof.config.json'),
    resolve(checkoutRoot, '.agents/woof.config.json'),
    resolve(checkoutRoot, '.claude/woof.config.json'),
  ]
  const physical = new Map<string, string>()
  for (const candidate of candidates) {
    try {
      const file = realpathSync(candidate)
      if (!statSync(file).isFile())
        throw new ProjectSelectionError(`Repository configuration is not a file: ${candidate}`)
      physical.set(file, candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  if (physical.size > 1)
    throw new ProjectSelectionError(
      `Multiple distinct repository configurations exist: ${[...physical.values()].join(', ')}. Keep only one of checkout-root woof.config.json, .agents/woof.config.json or .claude/woof.config.json.`,
    )
  return physical.keys().next().value as string | undefined
}

function loadRegistered(root: LoadedRoot, loader: ResourceLoader, name: string): RegisteredProject {
  const projects = root.data.$projects ?? {}
  if (!Object.prototype.hasOwnProperty.call(projects, name))
    throw new ProjectSelectionError(`Unknown registered project: ${name}.`)
  const definition = projects[name]!
  if (typeof definition === 'string') {
    const loaded = loader.loadProjectConfiguration(definition)
    return { kind: 'registered', name, data: loaded.data, source: loaded.source, inline: false }
  }
  return { kind: 'registered', name, data: definition, source: root.source, inline: true }
}

export function loadRegisteredProjects(root: LoadedRoot, loader: ResourceLoader) {
  return Object.keys(root.data.$projects ?? {}).map(name => loadRegistered(root, loader, name))
}

function normalizedMetadataPath(value: string, project: string) {
  const expanded = value === '~' ? homedir() : value.startsWith('~/') ? resolve(homedir(), value.slice(2)) : value
  if (!isAbsolute(expanded) && !win32.isAbsolute(expanded))
    throw new ProjectSelectionError(`Project ${project} metadata path must be absolute or begin with ~/: ${value}`)
  return normalize(expanded)
}

function existingPath(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function existingPatternPath(path: string) {
  const suffix: string[] = []
  let current = path
  for (;;) {
    try {
      return resolve(realpathSync(current), ...suffix)
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

function pathMatches(path: string, candidate: string) {
  const normalized = existingPath(path)
  return contained(normalized, candidate)
}

function globMatches(pattern: string, candidate: string, project: string) {
  try {
    const matches = picomatch(pattern, { dot: true })
    let current: string | undefined = candidate
    while (current) {
      if (matches(current)) return true
      const parent = dirname(current)
      current = parent === current ? undefined : parent
    }
    return false
  } catch (error) {
    throw new ProjectSelectionError(`Project ${project} has an invalid worktree glob: ${pattern}`, { cause: error })
  }
}

function metadataMatches(project: RegisteredProject, candidate: string) {
  const metadata = project.data.$metadata
  if (!metadata) return false
  const basePaths = (metadata.$basePaths ?? []).map(path => normalizedMetadataPath(path, project.name))
  const worktreePaths = (metadata.$worktreePaths ?? []).map(path =>
    existingPatternPath(normalizedMetadataPath(path, project.name)),
  )
  return (
    basePaths.some(path => pathMatches(path, candidate)) ||
    worktreePaths.some(pattern => globMatches(pattern, candidate, project.name))
  )
}

export function selectProjectContext(
  options: {
    cwd?: string
    project?: string
    inferredProject?: string
    loader?: ResourceLoader
  } = {},
) {
  const cwd = options.cwd ?? process.cwd()
  const loader = options.loader ?? createResourceLoader({ cwd })
  const root = loader.loadRootConfiguration()
  const checkoutRoot = detectCheckoutRoot(cwd)

  if (options.project) {
    return {
      root,
      project: loadRegistered(root, loader, options.project) as RegisteredProject | RepositoryProject,
      candidates: [] as RegisteredProject[],
      checkoutRoot,
      selection: 'explicit' as const,
    }
  }

  if (checkoutRoot && !insideWoofHome(cwd)) {
    const configuration = repositoryConfiguration(checkoutRoot)
    if (configuration) {
      const loaded = loader.loadRepositoryConfiguration(configuration)
      return {
        root,
        project: {
          kind: 'repository',
          name: undefined,
          data: loaded.data,
          source: loaded.source,
          inline: false,
        } as RegisteredProject | RepositoryProject,
        candidates: [] as RegisteredProject[],
        checkoutRoot,
        selection: 'repository' as const,
      }
    }
  }

  const candidatePath = realpathSync(cwd)
  const candidates = loadRegisteredProjects(root, loader).filter(project => metadataMatches(project, candidatePath))
  const inferred = options.inferredProject
  if (inferred && candidates.some(project => project.name === inferred))
    return {
      root,
      project: loadRegistered(root, loader, inferred) as RegisteredProject | RepositoryProject,
      candidates,
      checkoutRoot,
      selection: 'inference' as const,
    }
  if (candidates.length === 1)
    return {
      root,
      project: candidates[0]! as RegisteredProject | RepositoryProject,
      candidates,
      checkoutRoot,
      selection: 'metadata' as const,
    }
  if (candidates.length > 1) return { root, candidates, checkoutRoot, selection: 'ambiguous' as const }
  if (inferred)
    return {
      root,
      project: loadRegistered(root, loader, inferred) as RegisteredProject | RepositoryProject,
      candidates,
      checkoutRoot,
      selection: 'inference' as const,
    }
  return { root, candidates, checkoutRoot, selection: 'root' as const }
}
