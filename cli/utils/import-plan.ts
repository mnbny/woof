import type { WoofBundle } from './bundles.ts'
import type { ProjectDefinition } from './projects.ts'
import type { InlineProject, ProjectConfiguration, Resource, RootConfiguration, TokenValue } from './schema.ts'

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { readBundleArchive } from './bundles.ts'
import { parseConfigurationDocument, validateConfigurationDocument } from './config.ts'
import { getWoofHome } from './paths.ts'
import { selectProjectContext } from './projects.ts'
import { createResourceLoader, detectCheckoutRoot } from './resources.ts'
import { createTokenGraph, validateTokenGraph, validateTokenGraphForTransfer } from './tokens.ts'

export type ImportChoice = 'keep' | 'take'
export type ImportConflict = {
  id: string
  kind: 'token' | 'project' | 'project-token' | 'file'
  path: string
  existing: unknown
  incoming: unknown
  existingDigest: string
  incomingDigest: string
}
export type ImportSourceState = { path: string; digest: string | null }

type ProjectFile = { path: string; data: ProjectConfiguration }
type ImportPlanOptions = {
  cwd?: string
  home?: string
}

function digest(data: Uint8Array | string) {
  return createHash('sha256').update(data).digest('hex')
}

function valueDigest(value: unknown) {
  return value instanceof Uint8Array ? digest(value) : digest(JSON.stringify(value))
}

function conflict(kind: ImportConflict['kind'], path: string, existing: unknown, incoming: unknown): ImportConflict {
  const existingDigest = valueDigest(existing)
  const incomingDigest = valueDigest(incoming)
  return {
    id: digest(`${kind}\0${path}\0${existingDigest}\0${incomingDigest}`).slice(0, 32),
    kind,
    path,
    existing,
    incoming,
    existingDigest,
    incomingDigest,
  }
}

function namespace(value: unknown): value is Record<string, TokenValue> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !('$type' in value) && !('$exec' in value)
  )
}

function sourceEntries(value: object, project: boolean) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== '$schemaVersion' && key !== '$projects' && (!project || key !== '$metadata'),
    ),
  ) as Record<string, TokenValue>
}

function mergeTokens(
  local: Record<string, TokenValue>,
  incoming: Record<string, TokenValue>,
  kind: 'token' | 'project-token',
  choices: Readonly<Record<string, ImportChoice>>,
  conflicts: ImportConflict[],
  prefix = '',
): Record<string, TokenValue> {
  const result = structuredClone(local)
  for (const key of Object.keys(incoming).sort()) {
    const incomingValue = incoming[key]!
    if (!Object.prototype.hasOwnProperty.call(local, key)) {
      result[key] = structuredClone(incomingValue)
      continue
    }
    const localValue = local[key]!
    if (isDeepStrictEqual(localValue, incomingValue)) continue
    const path = prefix ? `${prefix}.${key}` : key
    if (namespace(localValue) && namespace(incomingValue)) {
      result[key] = mergeTokens(localValue, incomingValue, kind, choices, conflicts, path)
      continue
    }
    const item = conflict(kind, path, localValue, incomingValue)
    conflicts.push(item)
    result[key] = structuredClone(choices[item.id] === 'keep' ? localValue : incomingValue)
  }
  return result
}

function mergeDefinition(
  local: object,
  incoming: object,
  kind: 'token' | 'project-token',
  choices: Readonly<Record<string, ImportChoice>>,
  conflicts: ImportConflict[],
) {
  return mergeTokens(
    sourceEntries(local, kind === 'project-token'),
    sourceEntries(incoming, kind === 'project-token'),
    kind,
    choices,
    conflicts,
  )
}

function mergeMetadata(
  local: ProjectDefinition | undefined,
  incoming: ProjectDefinition,
  choices: Readonly<Record<string, ImportChoice>>,
  conflicts: ImportConflict[],
) {
  const existing = local?.$metadata
  const incomingMetadata = incoming.$metadata
  if (isDeepStrictEqual(existing, incomingMetadata)) return structuredClone(existing)
  if (existing === undefined) return structuredClone(incomingMetadata)
  if (incomingMetadata === undefined) return structuredClone(existing)
  const item = conflict('project-token', '$metadata', existing, incomingMetadata)
  conflicts.push(item)
  return structuredClone(choices[item.id] === 'keep' ? existing : incomingMetadata)
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
    throw new Error(`Unsafe home resource destination: ${path}`)
  return path
}

function contained(root: string, file: string) {
  const path = relative(root, file)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function readDestination(home: string, path: string): Uint8Array | undefined {
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

function sourceState(home: string, path: string): ImportSourceState & { data?: Uint8Array } {
  const data = readDestination(home, path)
  return { path, digest: data ? digest(data) : null, ...(data ? { data } : {}) }
}

function assertRepositoryImportAllowed(cwd: string) {
  const checkout = detectCheckoutRoot(cwd)
  if (!checkout) return
  for (const candidate of ['woof.config.json', '.agents/woof.config.json', '.claude/woof.config.json']) {
    try {
      if (statSync(realpathSync(join(checkout, candidate))).isFile())
        throw new Error(
          'Repository-defined projects cannot be imported. Run import from a registered home-project context.',
        )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

function localProject(local: RootConfiguration, bundle: WoofBundle, home: string) {
  const definition = local.$projects?.[bundle.projectName]
  if (definition === undefined) return { definition, data: undefined, file: undefined, source: undefined }
  if (typeof definition === 'string') {
    if (!definition.startsWith('<root>/'))
      throw new Error(`Local project ${bundle.projectName} is repository-defined and cannot be imported.`)
    const path = definition.slice('<root>/'.length)
    const source = sourceState(home, path)
    if (!source.data) throw new Error(`Local selected project configuration is missing: ${path}`)
    const original = parseConfigurationDocument(new TextDecoder().decode(source.data), 'project', path)
    return {
      definition,
      data: original,
      file: { path, data: original },
      source,
    }
  }
  return { definition, data: definition, file: undefined, source: undefined }
}

function definitionChoice(
  local: RootConfiguration,
  bundle: WoofBundle,
  choices: Readonly<Record<string, ImportChoice>>,
  conflicts: ImportConflict[],
) {
  const existing = local.$projects?.[bundle.projectName]
  const incoming = bundle.configuration.$projects![bundle.projectName]!
  if (existing === undefined || isDeepStrictEqual(existing, incoming)) return incoming
  if (typeof existing === 'object' && typeof incoming === 'object') return incoming
  const item = conflict('project', `$projects.${bundle.projectName}`, existing, incoming)
  conflicts.push(item)
  return choices[item.id] === 'keep' ? existing : incoming
}

function collectHomeReferences(value: TokenValue, references: Set<string>) {
  if (typeof value === 'string') {
    if (value.startsWith('<root>/')) references.add(value.slice('<root>/'.length))
    return
  }
  if ('$type' in value || '$exec' in value) {
    const resource = value as Resource
    if (resource.$type === 'prompt') {
      if (resource.$exec.startsWith('<root>/')) references.add(resource.$exec.slice('<root>/'.length))
    } else {
      for (const exec of Array.isArray(resource.$exec) ? resource.$exec : [resource.$exec])
        if (exec.startsWith('<root>/')) references.add(exec.slice('<root>/'.length))
    }
    return
  }
  for (const child of Object.values(value)) collectHomeReferences(child, references)
}

function writeStaged(stage: string, path: string, data: Uint8Array | string) {
  safePath(path)
  const destination = resolve(stage, path)
  if (!contained(stage, destination)) throw new Error(`Staged resource escapes its temporary home: ${path}`)
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  try {
    if (equalBytes(readFileSync(destination), bytes)) return
    throw new Error(`Staged path ${path} has inconsistent contents.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
}

function stageOtherProjects(
  configuration: RootConfiguration,
  selectedName: string,
  home: string,
  stage: string,
  references: Set<string>,
  sources: Map<string, ImportSourceState>,
) {
  const projects = new Map<string, ProjectDefinition>()
  const deferred: string[] = []
  for (const [name, definition] of Object.entries(configuration.$projects ?? {})) {
    if (name === selectedName) continue
    let data: ProjectDefinition
    if (typeof definition === 'string') {
      if (!definition.startsWith('<root>/')) {
        deferred.push(name)
        continue
      }
      const path = definition.slice('<root>/'.length)
      const source = sourceState(home, path)
      if (!source.data) throw new Error(`Candidate validation cannot read home project ${name} configuration ${path}.`)
      sources.set(path, { path, digest: source.digest })
      data = parseConfigurationDocument(new TextDecoder().decode(source.data), 'project', path)
      writeStaged(stage, path, source.data)
    } else data = definition
    projects.set(name, data)
    for (const [key, value] of Object.entries(data))
      if (key !== '$schemaVersion' && key !== '$metadata') collectHomeReferences(value as TokenValue, references)
  }
  return { projects, deferred }
}

function validateCandidate(
  configuration: RootConfiguration,
  projectName: string,
  projectFile: ProjectFile | undefined,
  files: ReadonlyMap<string, Uint8Array>,
  home: string,
  cwd: string,
  preserveOthers: boolean,
) {
  const stage = mkdtempSync(join(tmpdir(), 'woof-import-plan-'))
  const previousHome = process.env['WOOF_HOME']
  const sources = new Map<string, ImportSourceState>()
  const requirements = new Set<string>()
  try {
    writeStaged(stage, 'woof.config.json', `${JSON.stringify(configuration, null, 2)}\n`)
    if (projectFile) writeStaged(stage, projectFile.path, `${JSON.stringify(projectFile.data, null, 2)}\n`)
    const references = new Set<string>()
    for (const [key, value] of Object.entries(configuration))
      if (key !== '$schemaVersion' && key !== '$projects') collectHomeReferences(value as TokenValue, references)
    const project = configuration.$projects![projectName]!
    if (typeof project === 'object')
      for (const [key, value] of Object.entries(project))
        if (key !== '$metadata') collectHomeReferences(value as TokenValue, references)
    if (projectFile)
      for (const [key, value] of Object.entries(projectFile.data))
        if (key !== '$schemaVersion' && key !== '$metadata') collectHomeReferences(value as TokenValue, references)
    const other = preserveOthers
      ? stageOtherProjects(configuration, projectName, home, stage, references, sources)
      : { projects: new Map<string, ProjectDefinition>(), deferred: [] }
    for (const path of references) {
      const incoming = files.get(path)
      const data = incoming ?? readDestination(home, path)
      if (!data) throw new Error(`Candidate resource is missing: ${path}`)
      if (!incoming) sources.set(path, { path, digest: digest(data) })
      writeStaged(stage, path, data)
    }
    process.env['WOOF_HOME'] = stage
    const context = selectProjectContext({
      project: projectName,
      loader: createResourceLoader({ cwd }),
      cwd,
    })
    const rootOnlyContext = {
      root: context.root,
      candidates: [],
      checkoutRoot: context.checkoutRoot,
      selection: 'root' as const,
    }
    validateTokenGraph(createTokenGraph(rootOnlyContext))
    const validations = validateTokenGraphForTransfer(createTokenGraph(context))
    for (const validation of validations)
      for (const requirement of validation.deferredRequirements ?? []) requirements.add(requirement.reference)
    for (const name of other.projects.keys()) {
      try {
        const otherContext = selectProjectContext({
          project: name,
          loader: createResourceLoader({ cwd }),
          cwd,
        })
        const otherValidations = validateTokenGraphForTransfer(createTokenGraph(otherContext))
        for (const validation of otherValidations)
          for (const requirement of validation.deferredRequirements ?? []) requirements.add(requirement.reference)
      } catch (error) {
        throw new Error(
          `Candidate changes break registered project ${name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
    }
    return {
      requirements: [...requirements].sort(),
      deferredProjects: other.deferred.sort(),
      sources: [...sources.values()],
    }
  } finally {
    if (previousHome === undefined) delete process.env['WOOF_HOME']
    else process.env['WOOF_HOME'] = previousHome
    rmSync(stage, { recursive: true, force: true })
  }
}

function assertRawDestinationIsNotConfiguration(
  local: RootConfiguration,
  home: string,
  path: string,
  existing: Uint8Array | undefined,
) {
  const physical = existing ? realpathSync(resolve(home, path)) : undefined
  for (const [name, definition] of Object.entries(local.$projects ?? {})) {
    if (typeof definition !== 'string' || !definition.startsWith('<root>/')) continue
    const configPath = definition.slice('<root>/'.length)
    let configPhysical: string | undefined
    try {
      safePath(configPath)
      if (readDestination(home, configPath)) configPhysical = realpathSync(resolve(home, configPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (configPath === path || (physical && configPhysical === physical))
      throw new Error(
        `Raw payload destination ${path} belongs to registered project ${name}'s configuration. Choose a nonconflicting resource path or keep existing content; raw text must not replace project JSON.`,
      )
  }
}

export function planImport(archive: Uint8Array, options: ImportPlanOptions = {}) {
  const cwd = options.cwd ?? process.cwd()
  const home = realpathSync(options.home ?? getWoofHome())
  assertRepositoryImportAllowed(cwd)
  const bundle = readBundleArchive(archive)
  const rootSource = sourceState(home, 'woof.config.json')
  if (!rootSource.data)
    throw new Error('The local root configuration is missing; initialize Woof before import planning.')
  const local = parseConfigurationDocument(
    new TextDecoder().decode(rootSource.data),
    'root',
    getWoofHome('woof.config.json'),
  )
  const selected = localProject(local, bundle, home)
  const conflicts: ImportConflict[] = []
  mergeDefinition(local, bundle.configuration, 'token', {}, conflicts)
  definitionChoice(local, bundle, {}, conflicts)
  mergeDefinition(selected.data ?? {}, bundle.project, 'project-token', {}, conflicts)
  mergeMetadata(selected.data, bundle.project, {}, conflicts)

  const initialFiles = new Map<string, Uint8Array | undefined>()
  const incomingProjectPath = bundle.projectReference?.slice('<root>/'.length)
  for (const [path, data] of bundle.files) {
    if (path === 'woof.config.json' || path === incomingProjectPath) continue
    const existing = readDestination(home, path)
    initialFiles.set(path, existing)
    if (!existing || !equalBytes(existing, data)) assertRawDestinationIsNotConfiguration(local, home, path, existing)
    if (existing && !equalBytes(existing, data)) conflicts.push(conflict('file', path, existing, data))
  }
  if (incomingProjectPath && !initialFiles.has(incomingProjectPath))
    initialFiles.set(incomingProjectPath, readDestination(home, incomingProjectPath))
  if (selected.file && !initialFiles.has(selected.file.path))
    initialFiles.set(selected.file.path, readDestination(home, selected.file.path))

  const sourcePaths = new Set(['woof.config.json', ...initialFiles.keys()])
  if (selected.source) sourcePaths.add(selected.source.path)
  const sources = [...sourcePaths].sort().map(path => {
    if (path === rootSource.path) return { path, digest: rootSource.digest }
    if (selected.source?.path === path) return { path, digest: selected.source.digest }
    const data = initialFiles.get(path)
    return { path, digest: data ? digest(data) : null }
  })
  return {
    archiveDigest: digest(archive),
    bundle,
    conflicts,
    cwd,
    home,
    initialFiles,
    local,
    rootSource: { path: rootSource.path, digest: rootSource.digest },
    selected,
    sources,
  }
}

function assertProjectDestination(plan: ReturnType<typeof planImport>, projectFile: ProjectFile | undefined) {
  if (!projectFile) return
  const { path, data } = projectFile
  const existing = plan.initialFiles.get(path)
  const selected = plan.selected.file
  if (selected?.path === path && isDeepStrictEqual(selected.data, data)) return
  const finalBytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`)
  if (existing && equalBytes(existing, finalBytes)) return
  if (selected?.path !== path && existing)
    throw new Error(
      `Project configuration destination ${path} is occupied by unrelated local content. Choose a nonconflicting source project-config location and re-export, or keep the existing destination unchanged.`,
    )

  const targetPhysical = existing ? realpathSync(resolve(plan.home, path)) : undefined
  for (const [name, definition] of Object.entries(plan.local.$projects ?? {})) {
    if (name === plan.bundle.projectName || typeof definition !== 'string' || !definition.startsWith('<root>/'))
      continue
    const otherPath = definition.slice('<root>/'.length)
    let otherPhysical: string | undefined
    try {
      safePath(otherPath)
      if (readDestination(plan.home, otherPath)) otherPhysical = realpathSync(resolve(plan.home, otherPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (otherPath === path || (targetPhysical && otherPhysical === targetPhysical))
      throw new Error(
        `Project configuration destination ${path} is also used by registered project ${name}${otherPath === path ? '' : ` through ${otherPath}`}. Choose a nonconflicting source project-config location and re-export before changing it.`,
      )
  }
}

export function reviewImport(plan: ReturnType<typeof planImport>, choices: Readonly<Record<string, ImportChoice>>) {
  const conflictIds = new Set(plan.conflicts.map(item => item.id))
  for (const [id, choice] of Object.entries(choices)) {
    if (!conflictIds.has(id)) throw new Error(`Import decision ${id} is unknown or stale; review the archive again.`)
    if (choice !== 'keep' && choice !== 'take') throw new Error(`Import decision ${id} must be keep or take.`)
  }
  const unresolved = plan.conflicts.filter(item => !choices[item.id])
  if (unresolved.length) return { status: 'incomplete' as const, next: unresolved[0]!, remaining: unresolved.length }

  const conflicts: ImportConflict[] = []
  const shared = mergeDefinition(plan.local, plan.bundle.configuration, 'token', choices, conflicts)
  const definition = definitionChoice(plan.local, plan.bundle, choices, conflicts)
  const projectTokens = mergeDefinition(
    plan.selected.data ?? {},
    plan.bundle.project,
    'project-token',
    choices,
    conflicts,
  )
  const metadata = mergeMetadata(plan.selected.data, plan.bundle.project, choices, conflicts)
  const projectData = { ...projectTokens, ...(metadata ? { $metadata: metadata } : {}) } as InlineProject
  const projectFile =
    typeof definition === 'string'
      ? {
          path: definition.slice('<root>/'.length),
          data: validateConfigurationDocument({ ...projectData, $schemaVersion: 2 }, 'project', definition),
        }
      : undefined
  const configuration = validateConfigurationDocument(
    {
      ...shared,
      $schemaVersion: 2,
      $projects: {
        ...plan.local.$projects,
        [plan.bundle.projectName]: projectFile ? definition : projectData,
      },
    },
    'root',
    'import candidate',
  )
  const files = new Map<string, Uint8Array>()
  const fileConflicts = new Map(plan.conflicts.filter(item => item.kind === 'file').map(item => [item.path, item]))
  for (const [path, incoming] of plan.bundle.files) {
    if (
      path === 'woof.config.json' ||
      path === projectFile?.path ||
      path === plan.bundle.projectReference?.slice('<root>/'.length)
    )
      continue
    const item = fileConflicts.get(path)
    const existing = plan.initialFiles.get(path)
    files.set(path, item && choices[item.id] === 'keep' ? existing! : incoming)
  }
  assertProjectDestination(plan, projectFile)
  const sharedChanged = !isDeepStrictEqual(sourceEntries(plan.local, false), shared)
  const existingResourcesChanged = [...files].some(([path, data]) => {
    const original = plan.initialFiles.get(path)
    return original !== undefined && !equalBytes(original, data)
  })
  const validation = validateCandidate(
    configuration,
    plan.bundle.projectName,
    projectFile,
    files,
    plan.home,
    plan.cwd,
    sharedChanged || existingResourcesChanged,
  )
  const sources = [...plan.sources]
  for (const source of validation.sources)
    if (!sources.some(existing => existing.path === source.path)) sources.push(source)
  return {
    status: 'ready' as const,
    candidate: {
      configuration,
      deferredProjects: validation.deferredProjects,
      deferredRequirements: validation.requirements,
      files,
      home: plan.home,
      initialFiles: plan.initialFiles,
      initialProject: plan.selected.file,
      local: plan.local,
      projectFile,
      projectName: plan.bundle.projectName,
      sources,
    },
  }
}

export function assertImportSourcesCurrent(plan: ReturnType<typeof planImport>) {
  for (const source of plan.sources) {
    const current = sourceState(plan.home, source.path).digest
    if (current !== source.digest)
      throw new Error(`Import destination ${source.path} changed after review; stale decisions were not applied.`)
  }
}
