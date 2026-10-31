import type { selectProjectContext } from './projects.ts'
import type { ConfigurationSource, ResourceLocation } from './resources.ts'
import type { Resource, ScriptResource, TokenNamespace, TokenValue } from './schema.ts'

import { isMarkedResourceReference, readMarkedResource, resolveResourceLocation } from './resources.ts'

type ProjectContext = ReturnType<typeof selectProjectContext>
type LeafValue = string | Resource

export type EffectiveToken = {
  path: string
  value: LeafValue
  origin: 'root' | 'project'
  source: ConfigurationSource
  overridden: EffectiveToken | undefined
}

export type ScriptEvaluation = {
  token: EffectiveToken
  resource: ScriptResource
  locations: (ResourceLocation | undefined)[]
}
export type TokenEvaluator = (evaluation: ScriptEvaluation) => string | Promise<string>

export class TokenResolutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TokenResolutionError'
  }
}

const SEGMENT = /^[A-Za-z0-9_-]+$/
const ADDRESS = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/

function resourceLeaf(value: TokenValue): value is LeafValue {
  return typeof value === 'string' || (Boolean(value) && typeof value === 'object' && !Array.isArray(value))
}

function flatten(data: TokenNamespace, source: ConfigurationSource, origin: 'root' | 'project', reserved: Set<string>) {
  const tokens = new Map<string, EffectiveToken>()
  const namespaces = new Set<string>()
  function visit(namespace: TokenNamespace, prefix: string) {
    for (const [key, value] of Object.entries(namespace)) {
      if (reserved.has(key)) continue
      const path = prefix ? `${prefix}.${key}` : key
      if (resourceLeaf(value) && (typeof value === 'string' || '$type' in value || '$exec' in value)) {
        tokens.set(path, { path, value, origin, source, overridden: undefined })
      } else {
        namespaces.add(path)
        visit(value as TokenNamespace, path)
      }
    }
  }
  visit(data, '')
  return { tokens, namespaces }
}

export function createTokenGraph(context: ProjectContext) {
  const root = flatten(context.root.data, context.root.source, 'root', new Set(['$schemaVersion', '$projects']))
  const project = context.project
    ? flatten(context.project.data, context.project.source, 'project', new Set(['$schemaVersion', '$metadata']))
    : { tokens: new Map<string, EffectiveToken>(), namespaces: new Set<string>() }

  for (const [path, token] of project.tokens) {
    if (root.namespaces.has(path))
      throw new TokenResolutionError(`Project token ${path} is a leaf but the shared definition is a namespace.`)
    const overridden = root.tokens.get(path)
    project.tokens.set(path, { ...token, overridden })
  }
  for (const path of project.namespaces)
    if (root.tokens.has(path))
      throw new TokenResolutionError(`Project namespace ${path} conflicts with a shared leaf of the same name.`)

  const tokens = new Map(root.tokens)
  for (const [path, token] of project.tokens) tokens.set(path, token)
  return {
    context,
    tokens,
    rootTokens: root.tokens,
    rootNamespaces: root.namespaces,
    projectNamespaces: project.namespaces,
  }
}

type TokenGraph = ReturnType<typeof createTokenGraph>

type ContentPart = { kind: 'literal'; text: string } | { kind: 'reference'; path: string }

function contentParts(content: string): ContentPart[] {
  const parts: ContentPart[] = []
  function literal(text: string) {
    if (!text) return
    const previous = parts.at(-1)
    if (previous?.kind === 'literal') previous.text += text
    else parts.push({ kind: 'literal', text })
  }

  let index = 0
  while (index < content.length) {
    if (content.startsWith('{{{{', index)) {
      const close = content.indexOf('}}}}', index + 4)
      if (close !== -1) {
        const path = content.slice(index + 4, close)
        if (ADDRESS.test(path) && content[close + 4] !== '}') {
          literal(`{{${path}}}`)
          index = close + 4
          continue
        }
      }
    }
    if (content.startsWith('{{', index)) {
      const close = content.indexOf('}}', index + 2)
      if (close !== -1) {
        const path = content.slice(index + 2, close)
        if (
          ADDRESS.test(path) &&
          content[index - 1] !== '$' &&
          content[index - 1] !== '{' &&
          content[close + 2] !== '}'
        ) {
          parts.push({ kind: 'reference', path })
          index = close + 2
          continue
        }
      }
    }
    literal(content[index]!)
    index += 1
  }
  return parts
}

export function splitProjectAddress(address: string) {
  if (!address.startsWith('$projects.')) {
    if (!ADDRESS.test(address)) throw new TokenResolutionError(`Invalid token address: ${address}`)
    return { path: address }
  }
  const [, project, ...segments] = address.split('.')
  if (!project || !SEGMENT.test(project) || !segments.length || segments.some(segment => !SEGMENT.test(segment)))
    throw new TokenResolutionError(`Invalid qualified project address: ${address}`)
  return { project, path: segments.join('.') }
}

function graphAddress(graph: TokenGraph, address: string) {
  const parsed = splitProjectAddress(address)
  if (parsed.project) {
    const selected = graph.context.project
    if (selected?.kind !== 'registered' || selected.name !== parsed.project)
      throw new TokenResolutionError(
        `Address ${address} contradicts the selected project; select ${parsed.project} explicitly instead of mixing scopes.`,
      )
  }
  return parsed.path
}

function metadata(token: EffectiveToken) {
  if (typeof token.value === 'string') return { description: undefined, tags: undefined }
  return { description: token.value.$description, tags: token.value.$tags }
}

export function enumerateEffectiveTokens(graph: TokenGraph) {
  return [...graph.tokens.values()].map(token => {
    const wholeAlias = typeof token.value === 'string' ? contentParts(token.value) : []
    const first = wholeAlias[0]
    const alias = wholeAlias.length === 1 && first?.kind === 'reference' ? first.path : undefined
    return {
      path: token.path,
      kind: alias ? 'alias' : typeof token.value === 'string' ? 'prompt' : token.value.$type,
      target: alias,
      ...metadata(token),
      origin: token.origin,
      source: token.source,
    }
  })
}

function createWalker(graph: TokenGraph) {
  const traces = new Map<
    string,
    {
      path: string
      origin: 'root' | 'project'
      source: ConfigurationSource
      description: string | undefined
      tags: string[] | undefined
      references: string[]
      files: ResourceLocation[]
      overridden: { path: string; source: ConfigurationSource } | undefined
    }
  >()
  const payloads = new Map<string, { content: string; provenance: ResourceLocation }>()
  const evaluations = new Map<string, Promise<string>>()

  function location(reference: string, token: EffectiveToken) {
    if (token.origin === 'root' && reference.startsWith('<repo>/'))
      throw new TokenResolutionError(`Global token ${token.path} cannot depend on repository resource ${reference}.`)
    const checkoutRoot = graph.context.checkoutRoot
    return resolveResourceLocation(reference, checkoutRoot ? { repoRoot: checkoutRoot } : {})
  }

  function prompt(token: EffectiveToken) {
    if (typeof token.value !== 'string' && token.value.$type !== 'prompt')
      throw new TokenResolutionError(`Token ${token.path} is not a prompt.`)
    const authored = typeof token.value === 'string' ? token.value : token.value.$exec
    if (!isMarkedResourceReference(authored)) return { content: authored, parts: contentParts(authored), files: [] }
    const provenance = location(authored, token)
    const cached = payloads.get(authored)
    if (cached) return { content: cached.content, parts: contentParts(cached.content), files: [cached.provenance] }
    const checkoutRoot = graph.context.checkoutRoot
    const content = readMarkedResource(authored, checkoutRoot ? { repoRoot: checkoutRoot } : {}).content
    payloads.set(authored, { content, provenance })
    return { content, parts: contentParts(content), files: [provenance] }
  }

  function missing(path: string, chain: string[], token: EffectiveToken | undefined): never {
    const qualified = [...chain, path].join(' -> ')
    if (graph.rootNamespaces.has(path) || graph.projectNamespaces.has(path))
      throw new TokenResolutionError(`Token path ${path} is a namespace, not a resolvable value: ${qualified}`)
    if (token?.origin === 'root' && graph.context.project && !graph.rootTokens.has(path))
      throw new TokenResolutionError(`Global token ${token.path} depends on project-only token ${path}: ${qualified}`)
    throw new TokenResolutionError(`Missing token ${path}: ${qualified}`)
  }

  function visit(path: string, chain: string[]): void {
    if (chain.includes(path))
      throw new TokenResolutionError(`Circular token reference: ${[...chain, path].join(' -> ')}`)
    const token = graph.tokens.get(path)
    if (!token) return missing(path, chain, chain.length ? graph.tokens.get(chain.at(-1)!) : undefined)
    if (traces.has(path)) return

    const references: string[] = []
    const files: ResourceLocation[] = []
    if (typeof token.value === 'string' || token.value.$type === 'prompt') {
      const loaded = prompt(token)
      files.push(...loaded.files)
      for (const part of loaded.parts)
        if (part.kind === 'reference') {
          references.push(part.path)
          if (token.origin === 'root' && !graph.rootTokens.has(part.path)) missing(part.path, [...chain, path], token)
          visit(part.path, [...chain, path])
        }
    } else {
      const executions = Array.isArray(token.value.$exec) ? token.value.$exec : [token.value.$exec]
      for (const exec of executions) if (isMarkedResourceReference(exec)) files.push(location(exec, token))
    }

    traces.set(path, {
      path,
      origin: token.origin,
      source: token.source,
      ...metadata(token),
      references,
      files,
      overridden: token.overridden ? { path: token.overridden.path, source: token.overridden.source } : undefined,
    })
  }

  async function evaluate(path: string): Promise<string> {
    const cached = evaluations.get(path)
    if (cached) return cached
    const pending = (async () => {
      const token = graph.tokens.get(path)!
      if (typeof token.value !== 'string' && token.value.$type !== 'prompt') {
        if (!evaluateScript) throw new TokenResolutionError(`Computed token ${path} requires an evaluation hook.`)
        const resource = token.value as ScriptResource
        const executions = Array.isArray(resource.$exec) ? resource.$exec : [resource.$exec]
        const locations = executions.map(exec => (isMarkedResourceReference(exec) ? location(exec, token) : undefined))
        const output = await evaluateScript({ token, resource, locations })
        if (typeof output !== 'string')
          throw new TokenResolutionError(`Computed token ${path} returned non-text output.`)
        return output
      }
      const loaded = prompt(token)
      let output = ''
      for (const part of loaded.parts) {
        if (part.kind === 'literal') output += part.text
        else output += await evaluate(part.path)
      }
      return output
    })()
    evaluations.set(path, pending)
    return pending
  }

  let evaluateScript: TokenEvaluator | undefined
  return {
    visit,
    evaluate,
    setEvaluator(evaluator: TokenEvaluator | undefined) {
      evaluateScript = evaluator
    },
    traces() {
      return [...traces.values()]
    },
  }
}

function explanation(graph: TokenGraph, path: string, walker: ReturnType<typeof createWalker>) {
  return {
    requested: path,
    selection: graph.context.selection,
    project: graph.context.project
      ? { kind: graph.context.project.kind, name: graph.context.project.name, source: graph.context.project.source }
      : undefined,
    tokens: walker.traces(),
  }
}

export function preflightToken(graph: TokenGraph, address: string) {
  const path = graphAddress(graph, address)
  const walker = createWalker(graph)
  walker.visit(path, [])
  return explanation(graph, path, walker)
}

export function explainToken(graph: TokenGraph, address: string) {
  return preflightToken(graph, address)
}

export async function resolveToken(graph: TokenGraph, address: string, evaluator?: TokenEvaluator) {
  const path = graphAddress(graph, address)
  const walker = createWalker(graph)
  walker.setEvaluator(evaluator)
  walker.visit(path, [])
  return walker.evaluate(path)
}

export function validateTokenGraph(graph: TokenGraph, address?: string) {
  if (address) return [preflightToken(graph, address)]
  return [...graph.tokens.keys()].map(path => preflightToken(graph, path))
}
