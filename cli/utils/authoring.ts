import type { RegisteredProject, RepositoryProject } from './projects.ts'
import type { ProjectConfiguration, Resource, RootConfiguration, TokenValue } from './schema.ts'

import { createHash } from 'node:crypto'
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { replaceConfigurationFile, replaceFileContent, validateConfigurationDocument } from './config.ts'
import { inlineCodeText } from './display.ts'
import { withConfigurationLock } from './migrations.ts'
import { getWoofHome } from './paths.ts'
import {
  checkoutPath,
  insideWoofHome,
  loadRegisteredProjects,
  namedProjectCheckout,
  repositoryConfiguration,
  selectProjectContext,
} from './projects.ts'
import {
  createResourceLoader,
  detectCheckoutRoot,
  isMarkedResourceReference,
  resolveResourceLocation,
} from './resources.ts'
import { createTokenGraph, preflightToken } from './tokens.ts'

export const TOKEN_TYPES = ['prompt', 'bash', 'node', 'tsx', 'bun'] as const

export type TokenType = (typeof TOKEN_TYPES)[number]
export type TokenTarget = { kind: 'shared' } | { kind: 'repository' } | { kind: 'project'; name: string }
export type TokenContent = { exec: string; file?: string; copy?: string }
export type TokenDraft = {
  target: TokenTarget
  path: string
  type: TokenType
  content: TokenContent
  description: string | undefined
  tags: string[]
}

type ProjectContext = ReturnType<typeof selectProjectContext>

export function targetLabel(target: TokenTarget) {
  if (target.kind === 'shared') return 'shared tokens (global)'
  if (target.kind === 'repository') return 'repo tokens (project)'
  return `${target.name} tokens (project)`
}

// The place that a target stands for on this machine: the shared configuration or the project checkout.
export function targetPath(target: TokenTarget, cwd: string) {
  if (target.kind === 'shared') return getWoofHome('woof.config.json')
  if (target.kind === 'repository') return detectCheckoutRoot(cwd)
  const loader = createResourceLoader({ cwd })
  const project = loadRegisteredProjects(loader.loadRootConfiguration(), loader).find(
    candidate => candidate.name === target.name,
  )
  return project && checkoutPath(project)
}

const SEGMENT = /^[A-Za-z0-9_-]+$/
const PROTOTYPE_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

function contained(root: string, file: string) {
  const path = relative(root, file)
  return path !== '' && !path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)
}

function isNamespace(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !('$type' in value || '$exec' in value)
}

// A registered project lives inline in the root configuration or in its own file, so the target names the file
// and the place in it that holds the tokens.
function destination(target: TokenTarget, cwd: string) {
  const rootFile = getWoofHome('woof.config.json')
  if (target.kind === 'shared') return { file: rootFile, kind: 'root' as const, base: [] as string[] }
  if (target.kind === 'repository') {
    const checkout = detectCheckoutRoot(cwd)
    const file = checkout && !insideWoofHome(cwd) ? repositoryConfiguration(checkout) : undefined
    if (!file)
      throw new Error(
        `This checkout has no repository configuration. Create one with ${inlineCodeText('woof init --repo')}.`,
      )
    return { file, kind: 'repository' as const, base: [] as string[] }
  }
  const loader = createResourceLoader({ cwd })
  const projects = loader.loadRootConfiguration().data.$projects ?? {}
  if (!Object.hasOwn(projects, target.name))
    throw new Error(
      `Project ${inlineCodeText(target.name)} is not registered. See the registered projects with ${inlineCodeText('woof projects')}.`,
    )
  const definition = projects[target.name]!
  if (typeof definition === 'string')
    return {
      file: loader.loadProjectConfiguration(definition).source.file,
      kind: 'project' as const,
      base: [] as string[],
    }
  return { file: rootFile, kind: 'root' as const, base: ['$projects', target.name] }
}

// Adding needs a free path. Replacing needs an existing token at the path.
function insert(document: Record<string, unknown>, base: string[], path: string, value: TokenValue, replace = false) {
  const next = structuredClone(document)
  let namespace = base.reduce((node, key) => node[key] as Record<string, unknown>, next)
  const segments = path.split('.')
  for (const [index, segment] of segments.entries()) {
    const current = segments.slice(0, index + 1).join('.')
    const existing = Object.hasOwn(namespace, segment) ? namespace[segment] : undefined
    if (index === segments.length - 1) {
      if (replace && (existing === undefined || isNamespace(existing)))
        throw new Error(`Token ${inlineCodeText(current)} does not exist in this configuration.`)
      if (!replace && existing !== undefined)
        throw new Error(`Token ${inlineCodeText(current)} already exists in this configuration.`)
      namespace[segment] = value
    } else if (existing === undefined) {
      if (replace) throw new Error(`Token ${inlineCodeText(path)} does not exist in this configuration.`)
      namespace = namespace[segment] = {}
    } else if (isNamespace(existing)) namespace = existing
    else throw new Error(`Token ${inlineCodeText(current)} already exists, so it cannot hold ${inlineCodeText(path)}.`)
  }
  return next
}

// A prompt without metadata is a plain string. Every other token is a resource object.
function resourceValue(type: TokenType, exec: string | string[], description: string | undefined, tags: string[]) {
  if (type === 'prompt' && typeof exec === 'string' && !description && !tags.length) return exec
  return {
    $type: type,
    $exec: exec,
    ...(description ? { $description: description } : {}),
    ...(tags.length ? { $tags: tags } : {}),
  } as TokenValue
}

export function tokenValue(draft: Omit<TokenDraft, 'target' | 'path'>): TokenValue {
  return resourceValue(draft.type, draft.content.exec, draft.description, draft.tags)
}

// A copied file does not exist in woof home until the save, so checks read the source instead. A prompt file and
// inline text resolve references the same way, and script files are only checked for existence.
function checkedValue(draft: Omit<TokenDraft, 'target' | 'path'>) {
  if (!draft.content.copy) return tokenValue(draft)
  const exec = draft.type === 'prompt' ? readFileSync(draft.content.file!, 'utf8') : ''
  return tokenValue({ ...draft, content: { exec } })
}

export function assertTokenPath(path: string) {
  const segments = path.split('.')
  if (!segments.every(segment => SEGMENT.test(segment) && !PROTOTYPE_NAMES.has(segment)))
    throw new Error(
      `Token path ${inlineCodeText(path)} must be dot-separated names that contain only ASCII letters, digits, underscores and hyphens.`,
    )
}

// A single line that names an existing file becomes a file reference. woof home files and, for project tokens,
// checkout files keep their place. Other files are copied into woof home, because a reference must stay inside a root.
export function readTokenContent(content: string, options: { cwd: string; target: TokenTarget; path: string }) {
  if (!content.trim()) throw new Error('The token content is empty.')
  if (content.includes('\n') || isMarkedResourceReference(content)) return { exec: content }
  const expanded = content.startsWith('~/') ? join(homedir(), content.slice(2)) : resolve(options.cwd, content)
  let file: string
  try {
    file = realpathSync(expanded)
    if (!statSync(file).isFile()) return { exec: content }
  } catch {
    return { exec: content }
  }
  const home = realpathSync(getWoofHome())
  if (contained(home, file)) return { exec: `<root>/${relative(home, file).split(sep).join('/')}`, file }
  const checkout = detectCheckoutRoot(options.cwd)
  if (checkout && options.target.kind !== 'shared' && contained(checkout, file))
    return { exec: `<repo>/${relative(checkout, file).split(sep).join('/')}`, file }
  const copy = `resources/${options.path.replaceAll('.', '/')}${extname(file)}`
  try {
    statSync(join(home, copy))
    throw new Error(
      `woof home already has a file at ${inlineCodeText(copy)}. Move the file into woof home, or paste its content.`,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { exec: `<root>/${copy}`, file, copy }
}

// Checks the configuration with the token in place: its document, every project graph that the change reaches, and
// the references and files of the new token. Returns the changed document and whether the token overrides a shared one.
export function checkToken(
  draft: Omit<TokenDraft, 'type' | 'content' | 'description' | 'tags'> & { value: TokenValue; replace?: boolean },
  cwd: string,
) {
  assertTokenPath(draft.path)
  const target = destination(draft.target, cwd)
  const document = JSON.parse(readFileSync(target.file, 'utf8')) as Record<string, unknown>
  const next = insert(document, target.base, draft.path, draft.value, draft.replace)
  const validated = validateConfigurationDocument(next, target.kind, target.file)

  const loader = createResourceLoader({ cwd })
  const loadedRoot = loader.loadRootConfiguration()
  const root = target.kind === 'root' ? { ...loadedRoot, data: validated as RootConfiguration } : loadedRoot
  const checkoutRoot = loader.repoRoot
  const projectContext = (project: RegisteredProject | RepositoryProject): ProjectContext => ({
    root,
    project,
    candidates: [],
    checkoutRoot: project.kind === 'registered' ? namedProjectCheckout(project, cwd, checkoutRoot) : checkoutRoot,
    selection: 'explicit',
  })
  const rootContext: ProjectContext = { root, candidates: [], checkoutRoot, selection: 'root' }
  const registered = loadRegisteredProjects(root, loader).map(project =>
    draft.target.kind === 'project' && project.name === draft.target.name && !project.inline
      ? { ...project, data: validated as ProjectConfiguration }
      : project,
  )
  const checkout = detectCheckoutRoot(cwd)
  const repositoryFile = checkout && !insideWoofHome(cwd) ? repositoryConfiguration(checkout) : undefined
  const repository = repositoryFile
    ? {
        kind: 'repository' as const,
        name: undefined,
        data:
          draft.target.kind === 'repository'
            ? (validated as ProjectConfiguration)
            : loader.loadRepositoryConfiguration(repositoryFile).data,
        source: loader.loadRepositoryConfiguration(repositoryFile).source,
        inline: false as const,
      }
    : undefined

  // A shared token reaches every project, so each project must still combine with it.
  const contexts =
    draft.target.kind === 'shared'
      ? [rootContext, ...registered.map(projectContext), ...(repository ? [projectContext(repository)] : [])]
      : [
          draft.target.kind === 'repository'
            ? projectContext(repository!)
            : projectContext(registered.find(project => project.name === (draft.target as { name: string }).name)!),
        ]
  for (const context of contexts) {
    try {
      createTokenGraph(context)
    } catch (error) {
      const scope = context.project
        ? context.project.name
          ? `Project ${context.project.name}`
          : 'Repository project'
        : 'Shared tokens'
      throw new Error(`${scope}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }
  const graph = createTokenGraph(contexts[0]!)
  preflightToken(graph, draft.path)
  return {
    document,
    base: target.base,
    next,
    overrides: draft.target.kind !== 'shared' && graph.rootTokens.has(draft.path),
  }
}

export function checkDraft(draft: TokenDraft, cwd: string) {
  return checkToken({ target: draft.target, path: draft.path, value: checkedValue(draft) }, cwd)
}

export async function saveToken(draft: TokenDraft, cwd: string) {
  const { file } = destination(draft.target, cwd)
  return withConfigurationLock(file, target => {
    // The answers can be older than the file, so the save checks again under the lock.
    const checked = checkDraft(draft, cwd)
    const next = draft.content.copy
      ? insert(checked.document, checked.base, draft.path, tokenValue(draft))
      : checked.next
    let copied: string | undefined
    if (draft.content.copy) {
      copied = join(realpathSync(getWoofHome()), draft.content.copy)
      mkdirSync(dirname(copied), { recursive: true, mode: 0o700 })
      copyFileSync(draft.content.file!, copied, constants.COPYFILE_EXCL)
      chmodSync(copied, 0o600)
    }
    try {
      replaceConfigurationFile(target, next)
    } catch (error) {
      if (copied) rmSync(copied, { force: true })
      throw error
    }
    return { file: target, overrides: checked.overrides }
  })
}

export type TokenLayer = 'definition' | 'override'
// The script references replace those of the token, such as for an override with its own copy of the files.
export type TokenEdit = { content?: string; description?: string; tags?: string[]; exec?: string | string[] }

function digest(files: string[]) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(readFileSync(file))
  return hash.digest('hex')
}

function projectTarget(project: RegisteredProject | RepositoryProject): TokenTarget {
  return project.kind === 'repository' ? { kind: 'repository' } : { kind: 'project', name: project.name }
}

// Finds the definition behind the token that the caller sees. A prompt file is edited in place. A script file is
// edited outside woof, so its content is fixed here.
export function describeToken(address: string, options: { cwd: string; project?: string | undefined }) {
  const loader = createResourceLoader({ cwd: options.cwd })
  const context = selectProjectContext({
    cwd: options.cwd,
    loader,
    ...(options.project ? { project: options.project } : {}),
  })
  if (context.selection === 'ambiguous')
    throw new Error(
      `Several projects match this directory: ${context.candidates.map(candidate => inlineCodeText(candidate.name)).join(', ')}. Retry with ${inlineCodeText('--project NAME')}.`,
    )
  const graph = createTokenGraph(context)
  const token = graph.tokens.get(address)
  if (!token)
    throw new Error(
      graph.rootNamespaces.has(address) || graph.projectNamespaces.has(address)
        ? `${inlineCodeText(address)} is a namespace. Choose one token in it.`
        : `Token ${inlineCodeText(address)} does not exist. Find it with ${inlineCodeText('woof get --search')}.`,
    )
  const project = 'project' in context ? context.project : undefined
  const definition: TokenTarget = token.origin === 'root' ? { kind: 'shared' } : projectTarget(project!)
  const value = token.value as string | Resource
  const type: TokenType = typeof value === 'string' ? 'prompt' : value.$type
  const exec = typeof value === 'string' ? value : value.$exec
  const files = (Array.isArray(exec) ? exec : [exec])
    .filter(isMarkedResourceReference)
    .map(
      reference =>
        resolveResourceLocation(reference, context.checkoutRoot ? { repoRoot: context.checkoutRoot } : {}).file,
    )
  const kind = Array.isArray(exec) || (files.length && type !== 'prompt') ? 'fixed' : files.length ? 'file' : 'inline'
  const configuration = destination(definition, options.cwd).file
  return {
    path: address,
    value,
    type,
    exec,
    kind,
    files,
    content: kind === 'file' ? readFileSync(files[0]!, 'utf8') : kind === 'inline' ? (exec as string) : undefined,
    description: typeof value === 'string' ? undefined : value.$description,
    tags: typeof value === 'string' ? [] : (value.$tags ?? []),
    definition,
    // Only a shared token seen from a project can get an override in that project.
    override: token.origin === 'root' && project ? projectTarget(project) : undefined,
    configuration,
    version: digest([configuration, ...files]),
  }
}

export async function editToken(
  address: string,
  edit: TokenEdit,
  options: { cwd: string; project?: string | undefined; layer: TokenLayer; version?: string; check?: boolean },
) {
  const opened = describeToken(address, options)
  const target = options.layer === 'override' ? opened.override : opened.definition
  if (!target)
    throw new Error(
      `${inlineCodeText(address)} is not a shared token seen from a project, so it cannot get an override.`,
    )
  return withConfigurationLock(destination(target, options.cwd).file, file => {
    // The user can take a while, so the save reads the token again under the lock.
    const token = describeToken(address, options)
    if (options.version && token.version !== options.version)
      throw new Error(
        `${inlineCodeText(address)} changed after it was opened. Open it again to edit the current version.`,
      )
    if (edit.content !== undefined && token.kind === 'fixed')
      throw new Error(
        `The content of ${inlineCodeText(address)} is in ${token.files.map(file => inlineCodeText(file)).join(', ')}. Edit the file directly.`,
      )
    if (edit.content !== undefined && !edit.content.trim()) throw new Error('The token content is empty.')
    const description = edit.description === undefined ? token.description : edit.description.trim() || undefined
    const tags = edit.tags ?? token.tags
    const changed = edit.content !== undefined && edit.content !== token.content
    // A definition takes new prompt text into its file. An override keeps its text inline, so the shared file stays.
    const writesFile = changed && token.kind === 'file' && options.layer === 'definition'
    const value = resourceValue(
      token.type,
      changed && !writesFile ? edit.content! : (edit.exec ?? token.exec),
      description,
      tags,
    )
    if (options.layer === 'definition' && !writesFile && isDeepStrictEqual(value, token.value))
      return { file, contentFile: undefined, changed: false }

    const checked = checkToken(
      {
        target,
        path: address,
        value: writesFile ? resourceValue(token.type, edit.content!, description, tags) : value,
        replace: options.layer === 'definition',
      },
      options.cwd,
    )
    // A check runs every test of the save and stops before the write.
    if (options.check) return { file, contentFile: undefined, changed: true }
    const next = writesFile ? insert(checked.document, checked.base, address, value, true) : checked.next
    const original = writesFile ? readFileSync(token.files[0]!) : undefined
    if (writesFile) replaceFileContent(token.files[0]!, edit.content!)
    try {
      if (options.layer === 'override' || !isDeepStrictEqual(value, token.value)) replaceConfigurationFile(file, next)
    } catch (error) {
      if (original) replaceFileContent(token.files[0]!, original)
      throw error
    }
    return { file, contentFile: writesFile ? token.files[0] : undefined, changed: true }
  })
}

// An override of a script gets its own copy of the script files, so a change to the copy stays in the project. A
// repository keeps the copies next to its configuration, and a registered project keeps them in woof home.
export function copyScriptForOverride(address: string, options: { cwd: string; project?: string | undefined }) {
  const token = describeToken(address, options)
  const target = token.override
  if (!target || target.kind === 'shared' || token.kind !== 'fixed')
    throw new Error(`${inlineCodeText(address)} has no script files to copy.`)
  const checkout = detectCheckoutRoot(options.cwd)
  const home = realpathSync(getWoofHome())
  const base =
    target.kind === 'repository'
      ? { directory: join(dirname(destination(target, options.cwd).file), 'woof'), marker: '<repo>', root: checkout! }
      : { directory: join(home, 'resources', 'projects', target.name), marker: '<root>', root: home }
  const references = Array.isArray(token.exec) ? token.exec : [token.exec]
  const marked = [...new Set(references.filter(isMarkedResourceReference))]
  const segments = address.split('.')
  const copies = new Map(
    marked.map(reference => {
      const source = resolveResourceLocation(reference, checkout ? { repoRoot: checkout } : {}).file
      const file =
        marked.length === 1
          ? `${join(base.directory, ...segments)}${extname(source)}`
          : join(base.directory, ...segments, basename(source))
      return [reference, { source, file }] as const
    }),
  )
  for (const { file } of copies.values())
    if (existsSync(file)) throw new Error(`${inlineCodeText(file)} already exists. Move it away, then retry.`)
  const remove = () => {
    for (const { file } of copies.values()) rmSync(file, { force: true })
  }
  try {
    for (const { source, file } of copies.values()) {
      mkdirSync(dirname(file), { recursive: true })
      copyFileSync(source, file, constants.COPYFILE_EXCL)
    }
  } catch (error) {
    remove()
    throw error
  }
  const exec = references.map(reference => {
    const copy = copies.get(reference)
    return copy ? `${base.marker}/${relative(base.root, copy.file).split(sep).join('/')}` : reference
  })
  return {
    exec: Array.isArray(token.exec) ? exec : exec[0]!,
    files: [...copies.values()].map(copy => copy.file),
    remove,
  }
}
