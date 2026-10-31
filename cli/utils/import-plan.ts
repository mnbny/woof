import type { WoofBundle } from './bundles.ts'
import type { ImportLeaf } from './import-tokens.ts'
import type { InlineProject, ProjectConfiguration, RootConfiguration, TokenValue } from './schema.ts'

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { readBundleArchive } from './bundles.ts'
import { parseConfigurationDocument, validateConfigurationDocument } from './config.ts'
import { inspectWriteDestination } from './import-apply.ts'
import {
  assertImportAddress,
  flattenImportTokens,
  importTokenFiles,
  importTokenFingerprint,
  importValueAt,
  isImportLeaf,
  putImportValue,
  replaceImportTokenFiles,
  rewriteImportPromptBytes,
  rewriteImportToken,
} from './import-tokens.ts'
import { getWoofHome } from './paths.ts'
import { detectCheckoutRoot, resolveResourceLocation } from './resources.ts'
import { tokenReferencePaths } from './tokens.ts'

export type ImportChoice = 'keep' | 'take' | { action: 'add' | 'reuse'; address: string }
export type ImportConflict = {
  id: string
  kind: 'token' | 'project' | 'project-token' | 'file'
  path: string
  existing: unknown
  incoming: unknown
  existingDigest: string
  incomingDigest: string
  candidates?: string[]
  candidateDetails?: { address: string; description?: string; tags?: string[] }[]
  requiredNewPath?: boolean
  keepTakeOnly?: boolean
  invalid?: boolean
  notice?: string
}
export type ImportSourceState = { path: string; digest: string | null; physical: string | null }

type ProjectFile = { path: string; data: ProjectConfiguration }
type ImportPlanOptions = {
  cwd?: string
  home?: string
}

function digest(data: Uint8Array | string) {
  return createHash('sha256').update(data).digest('hex')
}

function valueDigest(value: unknown) {
  return value instanceof Uint8Array ? digest(value) : digest(JSON.stringify(value) ?? 'undefined')
}

function conflict(kind: ImportConflict['kind'], path: string, existing: unknown, incoming: unknown): ImportConflict {
  const existingDigest = valueDigest(existing)
  const incomingDigest = valueDigest(incoming)
  return {
    id: digest(`${kind}\0${path}`).slice(0, 32),
    kind,
    path,
    existing,
    incoming,
    existingDigest,
    incomingDigest,
  }
}

function sourceEntries(value: object, project: boolean) {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== '$schemaVersion' && key !== '$projects' && (!project || key !== '$metadata'),
    ),
  ) as Record<string, TokenValue>
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
  return {
    path,
    digest: data ? digest(data) : null,
    physical: inspectWriteDestination(home, path).target,
    ...(data ? { data } : {}),
  }
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

type Snapshot = ImportSourceState & { data?: Uint8Array }
type ImportPlan = {
  archiveDigest: string
  bundle: WoofBundle
  cwd: string
  home: string
  local: RootConfiguration
  selected: ReturnType<typeof localProject>
  snapshots: Map<string, Snapshot>
  external: Map<string, string>
  conflicts: ImportConflict[]
}

function snapshot(plan: ImportPlan, path: string) {
  let value = plan.snapshots.get(path)
  if (!value) {
    value = sourceState(plan.home, path)
    plan.snapshots.set(path, value)
  }
  return value
}

function readLocal(plan: ImportPlan, reference: string) {
  if (reference.startsWith('<root>/')) {
    try {
      return snapshot(plan, reference.slice('<root>/'.length)).data
    } catch {
      return undefined
    }
  }
  if (!reference.startsWith('<repo>/')) return undefined
  try {
    const file = resolveResourceLocation(reference, { cwd: plan.cwd }).file
    const bytes = readFileSync(file)
    const actual = digest(bytes)
    const prior = plan.external.get(file)
    if (prior && prior !== actual) throw new Error(`Reuse source changed during review: ${file}`)
    plan.external.set(file, actual)
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof Error && error.message.startsWith('Reuse source changed')) throw error
    return undefined
  }
}

function readIncoming(plan: ImportPlan, reference: string) {
  return reference.startsWith('<root>/') ? plan.bundle.files.get(reference.slice('<root>/'.length)) : undefined
}

function decisionAction(choice: ImportChoice | undefined) {
  return typeof choice === 'string' ? choice : choice?.action
}

function normalizedChoices(choices: Readonly<Record<string, ImportChoice>>) {
  for (const [id, choice] of Object.entries(choices)) {
    if (choice === 'keep' || choice === 'take') continue
    if (
      !choice ||
      typeof choice !== 'object' ||
      !['add', 'reuse'].includes(choice.action) ||
      typeof choice.address !== 'string'
    )
      throw new Error(`Import decision ${id} must be keep, take, or an add/reuse choice with an address.`)
  }
}

function tokenIssue(
  plan: ImportPlan,
  kind: 'token' | 'project-token',
  path: string,
  destination: string,
  existing: unknown,
  incoming: ImportLeaf,
  mappings: ReadonlyMap<string, string>,
  candidates: Map<string, ImportLeaf>,
) {
  const rewritten = rewriteImportToken(incoming, mappings)
  const item = conflict(kind, path, existing, rewritten)
  const signature = importTokenFingerprint(incoming, ref => readIncoming(plan, ref), mappings)
  item.incomingDigest = digest(`${item.incomingDigest}\0${signature ?? 'missing content'}`)
  item.existingDigest = digest(
    `${item.existingDigest}\0${isImportLeaf(existing as TokenValue) ? (importTokenFingerprint(existing as ImportLeaf, ref => readLocal(plan, ref)) ?? 'missing content') : ''}`,
  )
  item.candidates = [...candidates.entries()]
    .filter(
      ([, candidate]) =>
        signature !== undefined && importTokenFingerprint(candidate, ref => readLocal(plan, ref)) === signature,
    )
    .map(([address]) => address)
    .sort()
  item.candidateDetails = item.candidates.map(address => {
    const value = candidates.get(address)!
    return typeof value === 'string'
      ? { address }
      : {
          address,
          ...(value.$description !== undefined ? { description: value.$description } : {}),
          ...(value.$tags !== undefined ? { tags: value.$tags } : {}),
        }
  })
  if (kind === 'token' && existing !== undefined) {
    const projects = Object.keys(plan.local.$projects ?? {})
    if (projects.length) item.notice = `Taking this shared token may affect existing projects: ${projects.join(', ')}.`
  }
  if (signature === undefined)
    item.notice = `${item.notice ? `${item.notice} ` : ''}Incoming file content is unavailable; it cannot be matched for reuse.`
  if (destination !== path)
    item.notice = `${item.notice ? `${item.notice} ` : ''}Imported address maps to ${destination}.`
  return item
}

export function planImport(archive: Uint8Array, options: ImportPlanOptions = {}): ImportPlan {
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
  const plan: ImportPlan = {
    archiveDigest: digest(archive),
    bundle,
    cwd,
    home,
    local,
    selected,
    snapshots: new Map([[rootSource.path, rootSource]]),
    external: new Map(),
    conflicts: [],
  }
  if (selected.source) plan.snapshots.set(selected.source.path, selected.source)
  const incomingConfigPath = bundle.projectReference?.slice('<root>/'.length)
  if (incomingConfigPath) snapshot(plan, incomingConfigPath)
  for (const path of bundle.files.keys()) if (path !== 'woof.config.json') snapshot(plan, path)
  for (const definition of Object.values(local.$projects ?? {}))
    if (typeof definition === 'string') snapshot(plan, definition.slice('<root>/'.length))
  const described = describeImport(plan, {})
  plan.conflicts = described.issues
  return plan
}

function describeImport(plan: ImportPlan, choices: Readonly<Record<string, ImportChoice>>) {
  normalizedChoices(choices)
  const incomingRoot = flattenImportTokens(plan.bundle.configuration)
  const incomingProject = flattenImportTokens(plan.bundle.project)
  const localRoot = flattenImportTokens(plan.local)
  const localProjectTokens = flattenImportTokens(plan.selected.data ?? {})
  const mappings = new Map<string, string>()
  for (const path of incomingRoot.keys()) {
    const choice = choices[conflict('token', path, undefined, undefined).id]
    if (choice && typeof choice === 'object') {
      assertImportAddress(choice.address)
      mappings.set(path, choice.address)
    }
  }
  for (const path of incomingProject.keys()) {
    const choice = choices[conflict('project-token', path, undefined, undefined).id]
    if (choice && typeof choice === 'object' && !incomingRoot.has(path)) {
      assertImportAddress(choice.address)
      mappings.set(path, choice.address)
    }
  }
  const issues: ImportConflict[] = []
  const selectedTokens: {
    origin: 'root' | 'project'
    path: string
    value: ImportLeaf
    added: boolean
    item: ImportConflict
  }[] = []
  const reuses: {
    item: ImportConflict
    origin: 'root' | 'project'
    value: ImportLeaf
    address: string
    original: ImportLeaf
    binding?: string
    sourcePath?: string
  }[] = []
  const tokenChecks: {
    item: ImportConflict
    origin: 'root' | 'project'
    value: ImportLeaf
    candidates: Map<string, ImportLeaf>
  }[] = []
  const selectedAddresses = new Set<string>()
  const root = structuredClone(sourceEntries(plan.local, false)) as Record<string, unknown>
  const project = structuredClone(sourceEntries(plan.selected.data ?? {}, true)) as Record<string, unknown>
  const effective = new Map([...localRoot, ...localProjectTokens])

  const handle = (origin: 'root' | 'project', path: string, value: ImportLeaf) => {
    const kind = origin === 'root' ? 'token' : 'project-token'
    const id = conflict(kind, path, undefined, undefined).id
    const choice = choices[id]
    const action = decisionAction(choice)
    const bound = mappings.get(path) ?? path
    const destination = origin === 'root' && choice && typeof choice === 'object' ? choice.address : bound
    const base = origin === 'root' ? plan.local : (plan.selected.data ?? {})
    const existing = importValueAt(base, origin === 'root' ? path : destination)
    const item = tokenIssue(
      plan,
      kind,
      path,
      destination,
      existing,
      value,
      mappings,
      origin === 'root' ? localRoot : effective,
    )
    if (origin === 'project' && incomingRoot.has(path))
      item.notice = `${item.notice ? `${item.notice} ` : ''}A reused token at another address is connected through a project alias at ${bound}.`
    const same =
      destination === path &&
      isDeepStrictEqual(existing, item.incoming) &&
      isImportLeaf(existing as TokenValue) &&
      importTokenFingerprint(existing as ImportLeaf, ref => readLocal(plan, ref)) !== undefined &&
      importTokenFingerprint(existing as ImportLeaf, ref => readLocal(plan, ref)) ===
        importTokenFingerprint(value, ref => readIncoming(plan, ref), mappings)
    if (!same || choice) {
      issues.push(item)
      tokenChecks.push({ item, origin, value, candidates: origin === 'root' ? localRoot : effective })
    }
    if (same && !choice) return
    if (!action || action === 'keep') return
    if (action === 'reuse') {
      if (!choice || typeof choice === 'string' || !item.candidates?.includes(choice.address)) {
        item.invalid = true
        item.notice = `Reuse for ${path} is no longer compatible; review this choice again.`
        return
      }
      const original = (origin === 'root' ? localRoot : effective).get(choice.address)!
      const reuse: (typeof reuses)[number] = { item, origin, value, address: choice.address, original }
      reuses.push(reuse)
      if (origin === 'project' && incomingRoot.has(path) && bound !== choice.address) {
        const metadata =
          typeof original === 'string'
            ? {}
            : {
                ...(original.$description !== undefined ? { $description: original.$description } : {}),
                ...(original.$tags !== undefined ? { $tags: original.$tags } : {}),
              }
        const alias: ImportLeaf = Object.keys(metadata).length
          ? { $type: 'prompt', $exec: `{{${choice.address}}}`, ...metadata }
          : `{{${choice.address}}}`
        const existingBinding = importValueAt(plan.selected.data ?? {}, bound)
        if (existingBinding !== undefined && !isDeepStrictEqual(existingBinding, alias)) {
          const binding = conflict('project-token', `${path}\0binding`, existingBinding, alias)
          binding.path = bound
          binding.keepTakeOnly = true
          binding.notice = `The reused token needs a project alias at ${bound}. Taking replaces the existing project override; keeping it reopens this reuse choice.`
          issues.push(binding)
          const bindingChoice = choices[binding.id]
          if (bindingChoice && typeof bindingChoice === 'object') {
            binding.invalid = true
            binding.notice += ' Choose Keep existing or Take incoming.'
            return
          }
          if (bindingChoice === 'keep') {
            item.invalid = true
            item.notice = `Keeping the project override at ${bound} is incompatible with this reuse; review the reuse choice again.`
            return
          }
          if (bindingChoice !== 'take') return
        }
        const key = `project\0${bound}`
        if (selectedAddresses.has(key)) {
          item.invalid = true
          item.notice = `Multiple imported tokens target ${bound}; choose distinct addresses.`
          return
        }
        selectedAddresses.add(key)
        putImportValue(project, bound, alias)
        reuse.binding = bound
        reuse.sourcePath = path
        selectedTokens.push({ origin: 'project', path: bound, value: alias, added: false, item })
      }
      return
    }
    const target = action === 'add' && choice && typeof choice === 'object' ? choice.address : destination
    if (action === 'add') {
      if (origin === 'project' && incomingRoot.has(path) && mappings.get(path) && target !== mappings.get(path))
        throw new Error(`Project override ${path} must remain bound to ${mappings.get(path)}.`)
      assertImportAddress(target)
      const incomingAddresses = origin === 'root' ? incomingRoot : incomingProject
      if (target !== path && incomingAddresses.has(target)) {
        item.invalid = true
        item.notice = `The new address ${target} is already used by another incoming token.`
        return
      }
      if (
        importValueAt(plan.local, target) !== undefined ||
        importValueAt(plan.selected.data ?? {}, target) !== undefined
      ) {
        item.invalid = true
        item.notice = `The new token address ${target} is occupied; choose another address.`
        return
      }
      if (origin === 'project') mappings.set(path, target)
    }
    const key = `${origin}\0${target}`
    if (selectedAddresses.has(key)) {
      item.invalid = true
      item.notice = `Multiple imported tokens target ${target}; choose distinct addresses.`
      return
    }
    selectedAddresses.add(key)
    const node = origin === 'root' ? root : project
    try {
      putImportValue(node, target, item.incoming)
    } catch (error) {
      selectedAddresses.delete(key)
      item.invalid = true
      item.notice = error instanceof Error ? error.message : String(error)
      return
    }
    selectedTokens.push({ origin, path: target, value: item.incoming as ImportLeaf, added: action === 'add', item })
  }
  for (const [path, value] of incomingRoot) handle('root', path, value)
  const existingDefinition = plan.selected.definition
  const incomingDefinition = plan.bundle.configuration.$projects![plan.bundle.projectName]!
  const sameStorage =
    existingDefinition !== undefined &&
    ((typeof existingDefinition === 'object' && typeof incomingDefinition === 'object') ||
      existingDefinition === incomingDefinition)
  const projectItem = conflict(
    'project',
    `$projects.${plan.bundle.projectName}`,
    existingDefinition,
    incomingDefinition,
  )
  const importedProject = {
    ...sourceEntries(plan.bundle.project, true),
    ...(plan.bundle.project.$metadata ? { $metadata: plan.bundle.project.$metadata } : {}),
    $schemaVersion: 2,
  }
  const projectBytes = new TextEncoder().encode(`${JSON.stringify(importedProject, null, 2)}\n`)
  projectItem.candidates = [...plan.snapshots.values()]
    .filter(source => source.path !== 'woof.config.json' && source.data && equalBytes(source.data, projectBytes))
    .map(source => source.path)
  const projectChoice = choices[projectItem.id]
  if (!sameStorage) issues.push(projectItem)
  const includeProject = existingDefinition !== undefined || decisionAction(projectChoice) !== 'keep'
  if (includeProject) for (const [path, value] of incomingProject) handle('project', path, value)
  const existingMetadata = plan.selected.data?.$metadata
  const incomingMetadata = plan.bundle.project.$metadata
  let metadata = existingMetadata
  if (includeProject && incomingMetadata !== undefined && !isDeepStrictEqual(existingMetadata, incomingMetadata)) {
    const item = conflict('project-token', '$metadata', existingMetadata, incomingMetadata)
    issues.push(item)
    if (choices[item.id] && typeof choices[item.id] === 'object') {
      item.invalid = true
      item.notice = 'Project metadata supports Keep existing or Take incoming.'
    } else if (decisionAction(choices[item.id]) === 'take') metadata = incomingMetadata
  }
  return {
    issues,
    mappings,
    root,
    project,
    metadata,
    projectChoice,
    includeProject,
    selectedTokens,
    reuses,
    tokenChecks,
  }
}

export function reviewImport(plan: ImportPlan, choices: Readonly<Record<string, ImportChoice>>) {
  const described = describeImport(plan, choices)
  const issues = [...described.issues]
  const pending = () => issues.filter(item => !choices[item.id] || item.invalid)
  let unresolved: ImportConflict[]

  const files = new Map<string, Uint8Array>()
  const fileItems = new Map<string, ImportConflict>()
  const intents = new Map<
    string,
    { action: 'keep' | 'write' | 'reserve'; data?: Uint8Array; item: ImportConflict; added?: boolean }
  >()
  const paths = new Map<string, string>()
  const requirements = new Map<string, { reference: string; prompt: boolean; added: boolean }>()
  for (const token of described.selectedTokens) {
    const prompt = typeof token.value === 'string' || token.value.$type === 'prompt'
    for (const reference of importTokenFiles(token.value)) {
      const key = `${reference}\0${prompt ? 'prompt' : 'script'}`
      const prior = requirements.get(key)
      requirements.set(key, { reference, prompt, added: token.added || Boolean(prior?.added) })
    }
  }
  for (const [key, requirement] of requirements) {
    const reference = requirement.reference
    const originalPath = reference.startsWith('<root>/') ? reference.slice('<root>/'.length) : reference
    const incoming = readIncoming(plan, reference)
    let bytes = incoming
    let rewritten = false
    if (bytes && requirement.prompt) {
      const next = rewriteImportPromptBytes(bytes, described.mappings)
      if (next !== bytes) {
        bytes = next
        rewritten = true
      }
    }
    const existing = reference.startsWith('<root>/') ? snapshot(plan, originalPath).data : undefined
    const forcedNew = requirement.added || Boolean(bytes && rewritten)
    if (bytes && existing && equalBytes(bytes, existing) && !forcedNew) {
      paths.set(key, reference)
      continue
    }
    const item = conflict('file', `${originalPath}\0${requirement.prompt ? 'prompt' : 'script'}`, existing, bytes)
    item.path = originalPath
    item.requiredNewPath = forcedNew
    if (!bytes)
      item.notice = `Incoming file ${reference} is unavailable; ${forcedNew ? 'choose a distinct destination' : 'keeping the reference'} will produce a validation finding.`
    else if (forcedNew) item.notice = 'Choose a distinct destination for the imported file.'
    if (existing)
      item.notice = `${item.notice ? `${item.notice} ` : ''}Taking replaces this file for every existing token that uses it.`
    if (existing && reference.startsWith('<root>/')) {
      const physical = realpathSync(resolve(plan.home, originalPath))
      const owners = Object.entries(plan.local.$projects ?? {})
        .filter(([, value]) => {
          if (typeof value !== 'string') return false
          const candidate = snapshot(plan, value.slice('<root>/'.length))
          return candidate.data && realpathSync(resolve(plan.home, candidate.path)) === physical
        })
        .map(([name]) => name)
      if (owners.length)
        item.notice = `This file is registered as configuration for ${owners.join(', ')}. Taking raw bytes may prevent Woof from starting. ${item.notice ?? ''}`
    }
    const originalPhysical = reference.startsWith('<root>/') ? snapshot(plan, originalPath).physical : null
    item.candidates =
      bytes && !requirement.added
        ? [...plan.snapshots.values()]
            .filter(
              source =>
                source.data &&
                equalBytes(source.data, bytes!) &&
                (!forcedNew ||
                  (source.path !== originalPath && (!originalPhysical || source.physical !== originalPhysical))),
            )
            .map(source => source.path)
        : []
    issues.push(item)
    const choice = choices[item.id]
    const action = decisionAction(choice)
    if (!action) continue
    if (action === 'keep') {
      if (forcedNew) throw new Error(`File ${originalPath} requires a distinct destination; choose Add as new.`)
      if (reference.startsWith('<root>/')) {
        const source = snapshot(plan, originalPath)
        const identity = source.physical ?? resolve(plan.home, originalPath)
        const previous = intents.get(identity)
        if (
          previous &&
          previous.action !== 'keep' &&
          (!source.data || !previous.data || !equalBytes(source.data, previous.data))
        ) {
          item.invalid = true
          item.notice = `Keeping ${originalPath} conflicts with an earlier choice to replace the same file.`
          continue
        }
        intents.set(identity, { action: 'keep', item, ...(source.data ? { data: source.data } : {}) })
      }
      paths.set(key, reference)
      continue
    }
    if (!bytes) {
      if (forcedNew && choice && typeof choice === 'object' && choice.action === 'add') {
        const target = safePath(choice.address.replace(/^<root>\//, ''))
        const destination = snapshot(plan, target)
        if (target === originalPath || destination.physical === originalPhysical || destination.data)
          throw new Error(`Choose a distinct unused file destination instead of ${target}.`)
        const identity = destination.physical!
        if (intents.has(identity)) {
          item.invalid = true
          item.notice = 'This destination is already claimed by another import decision.'
          continue
        }
        intents.set(identity, { action: 'reserve', item })
        paths.set(key, `<root>/${target}`)
        continue
      }
      throw new Error(`File ${reference} is unavailable and cannot be taken or reused.`)
    }
    let target = originalPath
    if (choice && typeof choice === 'object') {
      target = safePath(choice.address.startsWith('<root>/') ? choice.address.slice('<root>/'.length) : choice.address)
      const destination = snapshot(plan, target).data
      if (choice.action === 'add' && (destination || (forcedNew && target === originalPath)))
        throw new Error(`Choose a distinct unused file destination instead of ${target}.`)
      if (choice.action === 'reuse' && (!destination || !equalBytes(destination, bytes)))
        throw new Error(`File ${target} is no longer identical; review reuse again.`)
      if (choice.action === 'reuse') {
        if (
          forcedNew &&
          (requirement.added ||
            target === originalPath ||
            (originalPhysical && snapshot(plan, target).physical === originalPhysical))
        )
          throw new Error('This file needs a distinct destination.')
        paths.set(key, `<root>/${target}`)
        continue
      }
    } else if (forcedNew) throw new Error(`File ${originalPath} requires a distinct destination; choose Add as new.`)
    if (target === 'woof.config.json') throw new Error('A raw payload cannot replace the root registry.')
    const destination = snapshot(plan, target)
    const identity = destination.physical ?? resolve(plan.home, target)
    const prior = intents.get(identity)
    if (
      prior &&
      (prior.action === 'reserve' ||
        prior.added ||
        (choice && typeof choice === 'object' && choice.action === 'add') ||
        !prior.data ||
        !equalBytes(prior.data, bytes))
    ) {
      item.invalid = true
      item.notice = `This choice conflicts with an earlier decision for the same file; select a different destination.`
      continue
    }
    intents.set(identity, {
      action: 'write',
      data: bytes,
      item,
      added: typeof choice === 'object' && choice.action === 'add',
    })
    const previous = files.get(target)
    if (previous && !equalBytes(previous, bytes))
      throw new Error(`Multiple imported files require incompatible bytes at ${target}.`)
    files.set(target, bytes)
    fileItems.set(target, item)
    paths.set(key, `<root>/${target}`)
  }
  function checkReuses(projectFile?: ProjectFile) {
    const replacements = new Map(files)
    if (projectFile)
      replacements.set(projectFile.path, new TextEncoder().encode(`${JSON.stringify(projectFile.data, null, 2)}\n`))
    const readAfter = (reference: string) => {
      if (!reference.startsWith('<root>/')) return readLocal(plan, reference)
      const path = reference.slice('<root>/'.length)
      const original = snapshot(plan, path)
      for (const [target, data] of replacements) {
        const destination = snapshot(plan, target)
        if (target === path || (original.physical && destination.physical === original.physical)) return data
      }
      return original.data
    }
    const sourceRoot = flattenImportTokens(plan.bundle.configuration)
    const sourceProject = flattenImportTokens(plan.bundle.project)
    const sourceHasCycle = (start: string) => {
      const seen = new Set<string>()
      const visit = (path: string): boolean => {
        if (path === start && seen.size) return true
        if (seen.has(path)) return false
        seen.add(path)
        const value = sourceProject.get(path) ?? sourceRoot.get(path)
        if (!value || (typeof value !== 'string' && value.$type !== 'prompt')) return false
        const source = typeof value === 'string' ? value : value.$exec
        const file = source.startsWith('<root>/') || source.startsWith('<repo>/')
        const bytes = file ? readIncoming(plan, source) : undefined
        if (file && !bytes) return false
        return tokenReferencePaths(bytes ? new TextDecoder().decode(bytes) : source).some(visit)
      }
      return visit(start)
    }
    for (const check of described.tokenChecks) {
      const expected = importTokenFingerprint(check.value, ref => readIncoming(plan, ref), described.mappings)
      check.item.candidates = [...check.candidates.entries()]
        .filter(([address, original]) => {
          const current =
            (check.origin === 'project' ? importValueAt(described.project, address) : undefined) ??
            importValueAt(described.root, address)
          return (
            expected !== undefined &&
            isDeepStrictEqual(current, original) &&
            isImportLeaf(current as TokenValue) &&
            importTokenFingerprint(current as ImportLeaf, readAfter) === expected
          )
        })
        .map(([address]) => address)
        .sort()
      check.item.candidateDetails = check.item.candidates.map(address => {
        const value = check.candidates.get(address)!
        return typeof value === 'string'
          ? { address }
          : {
              address,
              ...(value.$description !== undefined ? { description: value.$description } : {}),
              ...(value.$tags !== undefined ? { tags: value.$tags } : {}),
            }
      })
    }
    for (const reuse of described.reuses) {
      if (reuse.binding && reuse.sourcePath && reuse.binding !== reuse.sourcePath) {
        const seen = new Set<string>()
        const reachesBinding = (path: string): boolean => {
          if (path === reuse.binding) return true
          if (seen.has(path)) return false
          seen.add(path)
          const value = importValueAt(described.project, path) ?? importValueAt(described.root, path)
          if (!isImportLeaf(value as TokenValue)) return false
          const token = value as ImportLeaf
          if (typeof token !== 'string' && token.$type !== 'prompt') return false
          const source = typeof token === 'string' ? token : token.$exec
          const bytes = source.startsWith('<root>/') || source.startsWith('<repo>/') ? readAfter(source) : undefined
          if ((source.startsWith('<root>/') || source.startsWith('<repo>/')) && !bytes) return false
          const content = bytes ? new TextDecoder().decode(bytes) : source
          return tokenReferencePaths(content).some(reachesBinding)
        }
        if (reachesBinding(reuse.address) && !sourceHasCycle(reuse.sourcePath)) {
          reuse.item.invalid = true
          reuse.item.notice = `Reuse would make the project binding ${reuse.binding} reference itself; choose a different mapping.`
          const base = issues.find(item => item.id === conflict('token', reuse.sourcePath!, undefined, undefined).id)
          if (base && choices[base.id] && typeof choices[base.id] === 'object') {
            base.invalid = true
            base.notice = `This mapping makes the reused project override circular; choose a different address.`
          }
          continue
        }
      }
      const current =
        (reuse.origin === 'project' ? importValueAt(described.project, reuse.address) : undefined) ??
        importValueAt(described.root, reuse.address)
      const incoming = importTokenFingerprint(reuse.value, ref => readIncoming(plan, ref), described.mappings)
      const after = isImportLeaf(current as TokenValue)
        ? importTokenFingerprint(current as ImportLeaf, readAfter)
        : undefined
      if (!isDeepStrictEqual(current, reuse.original) || !incoming || after !== incoming) {
        reuse.item.invalid = true
        reuse.item.notice = `The reused token ${reuse.address} changes under another choice; review this reuse again.`
        reuse.item.candidates = (reuse.item.candidates ?? []).filter(address => address !== reuse.address)
        if (!isDeepStrictEqual(current, reuse.original)) {
          for (const token of described.selectedTokens) {
            if (token.path === reuse.address && (reuse.origin === 'project' || token.origin === 'root')) {
              token.item.invalid = true
              token.item.notice = `This token change conflicts with reuse of ${reuse.address}; review both choices.`
            }
          }
        }
        for (const reference of importTokenFiles(reuse.original)) {
          if (!reference.startsWith('<root>/')) continue
          const sourcePath = reference.slice('<root>/'.length)
          const source = snapshot(plan, sourcePath)
          for (const [target, item] of fileItems) {
            const destination = snapshot(plan, target)
            if (target === sourcePath || (source.physical && source.physical === destination.physical)) {
              item.invalid = true
              item.notice = `This file change conflicts with reuse of ${reuse.address}; review both choices.`
            }
          }
        }
      }
    }
  }
  checkReuses()
  unresolved = pending()
  if (unresolved.length)
    return { status: 'incomplete' as const, next: unresolved[0]!, remaining: unresolved.length, issues }

  for (const token of described.selectedTokens) {
    const prompt = typeof token.value === 'string' || token.value.$type === 'prompt'
    const replacements = new Map<string, string>()
    for (const reference of importTokenFiles(token.value)) {
      const target = paths.get(`${reference}\0${prompt ? 'prompt' : 'script'}`)
      if (target) replacements.set(reference, target)
    }
    const updated = replaceImportTokenFiles(token.value, replacements)
    putImportValue(token.origin === 'root' ? described.root : described.project, token.path, updated)
  }
  const existingDefinition = plan.selected.definition
  const incomingDefinition = plan.bundle.configuration.$projects![plan.bundle.projectName]!
  const projectAction = decisionAction(described.projectChoice)
  let definition = projectAction === 'keep' ? existingDefinition : incomingDefinition
  if (described.projectChoice && typeof described.projectChoice === 'object') {
    const path = safePath(described.projectChoice.address.replace(/^<root>\//, ''))
    const existing = snapshot(plan, path).data
    if (described.projectChoice.action === 'add' && existing) {
      const item = issues.find(
        entry => entry.id === conflict('project', `$projects.${plan.bundle.projectName}`, undefined, undefined).id,
      )!
      item.invalid = true
      item.notice = `Project storage ${path} is occupied; choose another path.`
      return { status: 'incomplete' as const, next: item, remaining: 1, issues }
    }
    definition = `<root>/${path}`
  }
  const projectData = {
    ...described.project,
    ...(described.metadata ? { $metadata: described.metadata } : {}),
  } as InlineProject
  let projectFile: ProjectFile | undefined
  if (described.includeProject && typeof definition === 'string') {
    const path = definition.slice('<root>/'.length)
    const data = validateConfigurationDocument({ ...projectData, $schemaVersion: 2 }, 'project', definition)
    const bytes = new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`)
    const existing = snapshot(plan, path).data
    if (
      described.projectChoice &&
      typeof described.projectChoice === 'object' &&
      described.projectChoice.action === 'reuse' &&
      (!existing || !equalBytes(existing, bytes))
    ) {
      const item = issues.find(
        entry => entry.id === conflict('project', `$projects.${plan.bundle.projectName}`, undefined, undefined).id,
      )!
      item.invalid = true
      item.notice = `Project storage ${path} is no longer identical; review reuse again.`
      return { status: 'incomplete' as const, next: item, remaining: 1, issues }
    }
    const unchangedProject = plan.selected.file?.path === path && isDeepStrictEqual(plan.selected.file.data, data)
    if (!unchangedProject && (!existing || !equalBytes(existing, bytes))) {
      const item = conflict('file', `${path}\0project configuration`, existing, bytes)
      item.path = path
      item.candidates = [...plan.snapshots.values()]
        .filter(source => source.data && equalBytes(source.data, bytes))
        .map(source => source.path)
      const targetPhysical = snapshot(plan, path).physical
      const owners = Object.entries(plan.local.$projects ?? {})
        .filter(([, value]) => {
          if (typeof value !== 'string') return false
          const source = snapshot(plan, value.slice('<root>/'.length))
          return source.path === path || Boolean(targetPhysical && source.physical === targetPhysical)
        })
        .map(([name]) => name)
      if (owners.length)
        item.notice = `This configuration is used by ${owners.join(', ')}; taking changes affects those projects.`
      issues.push(item)
      const choice = choices[item.id]
      const action = decisionAction(choice)
      let target = path
      if (choice && typeof choice === 'object') target = safePath(choice.address.replace(/^<root>\//, ''))
      const destination = snapshot(plan, target)
      if (choice && typeof choice === 'object' && choice.action === 'add' && destination.data)
        throw new Error(`Project storage ${target} is occupied.`)
      if (
        choice &&
        typeof choice === 'object' &&
        choice.action === 'reuse' &&
        (!destination.data || !equalBytes(destination.data, bytes))
      )
        throw new Error(`Project storage ${target} is not identical.`)
      const identity = destination.physical ?? resolve(plan.home, target)
      const prior = intents.get(identity)
      const desired = action === 'keep' ? destination.data : bytes
      if (
        action &&
        prior &&
        (prior.action === 'reserve' ||
          prior.added ||
          (choice && typeof choice === 'object' && choice.action === 'add') ||
          !prior.data ||
          !desired ||
          !equalBytes(prior.data, desired))
      ) {
        item.invalid = true
        item.notice = `This decision conflicts with another choice for the same physical file.`
      } else if (action === 'take') {
        projectFile = { path, data }
        fileItems.set(path, item)
      } else if (choice && typeof choice === 'object') {
        definition = `<root>/${target}`
        if (choice.action === 'add') {
          projectFile = { path: target, data }
          fileItems.set(target, item)
        }
      }
    } else projectFile = { path, data }
  }
  if (projectFile) {
    const target = snapshot(plan, projectFile.path)
    const prior = intents.get(target.physical!)
    const bytes = new TextEncoder().encode(`${JSON.stringify(projectFile.data, null, 2)}\n`)
    if (prior && (!prior.data || !equalBytes(prior.data, bytes))) {
      prior.item.invalid = true
      prior.item.notice = 'This destination conflicts with the imported project configuration.'
    }
  }
  checkReuses(projectFile)
  unresolved = pending()
  if (unresolved.length)
    return { status: 'incomplete' as const, next: unresolved[0]!, remaining: unresolved.length, issues }
  const projects = { ...plan.local.$projects }
  if (described.includeProject)
    projects[plan.bundle.projectName] = typeof definition === 'string' ? definition : projectData
  const configuration = validateConfigurationDocument(
    { ...described.root, $schemaVersion: 2, $projects: projects },
    'root',
    'import candidate',
  )
  if (projectFile && files.has(projectFile.path)) {
    const projectBytes = new TextEncoder().encode(`${JSON.stringify(projectFile.data, null, 2)}\n`)
    if (!equalBytes(files.get(projectFile.path)!, projectBytes))
      throw new Error(`Project configuration and raw payload require incompatible writes to ${projectFile.path}.`)
  }
  const sourcePaths = [...plan.snapshots.values()].map(({ path, digest: hash, physical }) => ({
    path,
    digest: hash,
    physical,
  }))
  return {
    status: 'ready' as const,
    issues,
    candidate: {
      configuration,
      files,
      home: plan.home,
      local: plan.local,
      projectFile,
      projectName: plan.bundle.projectName,
      initialProject: plan.selected.file,
      sources: sourcePaths,
      externalSources: [...plan.external].map(([path, hash]) => ({ path, digest: hash })),
    },
  }
}

export function importReviewSources(plan: ImportPlan) {
  return {
    home: [...plan.snapshots.values()].map(({ path, digest: hash, physical }) => ({ path, digest: hash, physical })),
    external: [...plan.external].map(([path, hash]) => ({ path, digest: hash })),
  }
}

export function verifyImportReviewSources(plan: ImportPlan, saved: ReturnType<typeof importReviewSources>) {
  if (!saved || !Array.isArray(saved.home) || !Array.isArray(saved.external))
    throw new Error('Decisions are missing reviewed source snapshots.')
  for (const source of saved.home) {
    if (
      !source ||
      typeof source.path !== 'string' ||
      (typeof source.digest !== 'string' && source.digest !== null) ||
      (typeof source.physical !== 'string' && source.physical !== null)
    )
      throw new Error('Decisions contain invalid source snapshots.')
    const current = snapshot(plan, source.path)
    if (current.digest !== source.digest || current.physical !== source.physical)
      throw new Error(`Import destination ${source.path} changed after review; review it again.`)
  }
  const checkout = detectCheckoutRoot(plan.cwd)
  for (const source of saved.external) {
    if (
      !source ||
      typeof source.path !== 'string' ||
      typeof source.digest !== 'string' ||
      !checkout ||
      !contained(checkout, source.path)
    )
      throw new Error('Decisions contain an invalid checkout source.')
    const physical = realpathSync(source.path)
    if (!contained(checkout, physical) || digest(readFileSync(physical)) !== source.digest)
      throw new Error(`Reuse source ${source.path} changed after review.`)
    plan.external.set(physical, source.digest)
  }
}
