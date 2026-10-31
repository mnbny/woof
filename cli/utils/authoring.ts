import type { RegisteredProject, RepositoryProject, selectProjectContext } from './projects.ts'
import type { ProjectConfiguration, RootConfiguration, TokenValue } from './schema.ts'

import { chmodSync, constants, copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { replaceConfigurationFile, validateConfigurationDocument } from './config.ts'
import { withConfigurationLock } from './migrations.ts'
import { getWoofHome } from './paths.ts'
import { insideWoofHome, loadRegisteredProjects, repositoryConfiguration } from './projects.ts'
import { createResourceLoader, detectCheckoutRoot, isMarkedResourceReference } from './resources.ts'
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
    if (!file) throw new Error('This checkout has no repository configuration. Create one with woof init --repo.')
    return { file, kind: 'repository' as const, base: [] as string[] }
  }
  const loader = createResourceLoader({ cwd })
  const projects = loader.loadRootConfiguration().data.$projects ?? {}
  if (!Object.hasOwn(projects, target.name)) throw new Error(`Unknown registered project: ${target.name}.`)
  const definition = projects[target.name]!
  if (typeof definition === 'string')
    return {
      file: loader.loadProjectConfiguration(definition).source.file,
      kind: 'project' as const,
      base: [] as string[],
    }
  return { file: rootFile, kind: 'root' as const, base: ['$projects', target.name] }
}

function insert(document: Record<string, unknown>, base: string[], path: string, value: TokenValue) {
  const next = structuredClone(document)
  let namespace = base.reduce((node, key) => node[key] as Record<string, unknown>, next)
  const segments = path.split('.')
  for (const [index, segment] of segments.entries()) {
    const current = segments.slice(0, index + 1).join('.')
    const existing = Object.hasOwn(namespace, segment) ? namespace[segment] : undefined
    if (index === segments.length - 1) {
      if (existing !== undefined) throw new Error(`Token ${current} already exists in this configuration.`)
      namespace[segment] = value
    } else if (existing === undefined) namespace = namespace[segment] = {}
    else if (isNamespace(existing)) namespace = existing
    else throw new Error(`Token ${current} already exists, so it cannot hold ${path}.`)
  }
  return next
}

export function tokenValue(draft: Omit<TokenDraft, 'target' | 'path'>): TokenValue {
  const { type, content, description, tags } = draft
  if (type === 'prompt' && !description && !tags.length) return content.exec
  return {
    $type: type,
    $exec: content.exec,
    ...(description ? { $description: description } : {}),
    ...(tags.length ? { $tags: tags } : {}),
  } as TokenValue
}

// A copied file does not exist in Woof home until the save, so checks read the source instead. A prompt file and
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
      `Token path ${path} must be dot-separated names that contain only ASCII letters, digits, underscores and hyphens.`,
    )
}

// A single line that names an existing file becomes a file reference. Woof home files and, for project tokens,
// checkout files keep their place. Other files are copied into Woof home, because a reference must stay inside a root.
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
    throw new Error(`Woof home already has a file at ${copy}. Move the file into Woof home, or paste its content.`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { exec: `<root>/${copy}`, file, copy }
}

// Checks the configuration with the token in place: its document, every project graph that the change reaches, and
// the references and files of the new token. Returns the changed document and whether the token overrides a shared one.
export function checkToken(
  draft: Omit<TokenDraft, 'type' | 'content' | 'description' | 'tags'> & { value: TokenValue },
  cwd: string,
) {
  assertTokenPath(draft.path)
  const target = destination(draft.target, cwd)
  const document = JSON.parse(readFileSync(target.file, 'utf8')) as Record<string, unknown>
  const next = insert(document, target.base, draft.path, draft.value)
  const validated = validateConfigurationDocument(next, target.kind, target.file)

  const loader = createResourceLoader({ cwd })
  const loadedRoot = loader.loadRootConfiguration()
  const root = target.kind === 'root' ? { ...loadedRoot, data: validated as RootConfiguration } : loadedRoot
  const checkoutRoot = loader.repoRoot
  const projectContext = (project: RegisteredProject | RepositoryProject): ProjectContext => ({
    root,
    project,
    candidates: [],
    checkoutRoot,
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
