import type { selectProjectContext } from './projects.ts'
import type { ConfigurationSource, ResourceLocation } from './resources.ts'
import type { Resource, ScriptResource, SecretBindings, TokenNamespace, TokenValue } from './schema.ts'

import { inlineCodeText, shellQuote } from './display.ts'
import { renderTemplateFile } from './presentation.ts'
import { hasPrivatePlaceholder, PRIVATE_MARKER } from './private.ts'
import {
  isMarkedResourceReference,
  readMarkedResource,
  resolveResourceLocation,
  ResourceLoadError,
} from './resources.ts'
import { createSecretLookup, resolveSecretBindings, secretBindingText } from './secrets.ts'

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
  secretEnvironment: NodeJS.ProcessEnv
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
      throw new TokenResolutionError(
        `Project token ${inlineCodeText(path)} is a leaf but the shared definition is a namespace.`,
      )
    const overridden = root.tokens.get(path)
    project.tokens.set(path, { ...token, overridden })
  }
  for (const path of project.namespaces)
    if (root.tokens.has(path))
      throw new TokenResolutionError(
        `Project namespace ${inlineCodeText(path)} conflicts with a shared leaf of the same name.`,
      )

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

type ContentPart =
  { kind: 'literal'; text: string } | { kind: 'reference' | 'deferred'; path: string } | { kind: 'private' }

export function internalMarker(path: string) {
  return /^-[^{}\s]*-$/.test(path)
}

function deferredPath(value: string) {
  const path = value.slice(1, -1)
  return value.startsWith('~') && value.endsWith('~') && ADDRESS.test(path) ? path : undefined
}

function contentParts(content: string) {
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
        if ((ADDRESS.test(path) || internalMarker(path) || deferredPath(path)) && content[close + 4] !== '}') {
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
        const deferred = deferredPath(path)
        if (
          (ADDRESS.test(path) || internalMarker(path) || deferred) &&
          content[index - 1] !== '$' &&
          content[index - 1] !== '{' &&
          content[close + 2] !== '}'
        ) {
          if (`{{${path}}}` === PRIVATE_MARKER) parts.push({ kind: 'private' })
          else if (internalMarker(path)) literal(`{{${path}}}`)
          else if (deferred) parts.push({ kind: 'deferred', path: deferred })
          else parts.push({ kind: 'reference', path })
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

export function tokenReferencePaths(content: string) {
  return contentParts(content).flatMap(part => (part.kind === 'reference' ? [part.path] : []))
}

export function tokenReferences(content: string) {
  return contentParts(content).flatMap(part => (part.kind === 'reference' || part.kind === 'deferred' ? [part] : []))
}

export function rewriteTokenReferences(content: string, mappings: ReadonlyMap<string, string>) {
  let output = ''
  let index = 0
  while (index < content.length) {
    if (content.startsWith('{{{{', index)) {
      const close = content.indexOf('}}}}', index + 4)
      if (close !== -1) {
        const path = content.slice(index + 4, close)
        if ((ADDRESS.test(path) || internalMarker(path) || deferredPath(path)) && content[close + 4] !== '}') {
          output += content.slice(index, close + 4)
          index = close + 4
          continue
        }
      }
    }
    if (content.startsWith('{{', index)) {
      const close = content.indexOf('}}', index + 2)
      if (close !== -1) {
        const path = content.slice(index + 2, close)
        const deferred = deferredPath(path)
        if (
          ((ADDRESS.test(path) && !internalMarker(path)) || deferred) &&
          content[index - 1] !== '$' &&
          content[index - 1] !== '{' &&
          content[close + 2] !== '}'
        ) {
          const target = mappings.get(deferred ?? path) ?? deferred ?? path
          output += deferred ? `{{~${target}~}}` : `{{${target}}}`
          index = close + 2
          continue
        }
      }
    }
    output += content[index]!
    index += 1
  }
  return output
}

export function splitProjectAddress(address: string) {
  if (!address.startsWith('$projects.')) {
    if (!ADDRESS.test(address)) throw new TokenResolutionError(`Invalid token address: ${inlineCodeText(address)}`)
    return { path: address }
  }
  const [, project, ...segments] = address.split('.')
  if (!project || !SEGMENT.test(project) || !segments.length || segments.some(segment => !SEGMENT.test(segment)))
    throw new TokenResolutionError(`Invalid qualified project address: ${inlineCodeText(address)}`)
  return { project, path: segments.join('.') }
}

function graphAddress(graph: TokenGraph, address: string) {
  const parsed = splitProjectAddress(address)
  if (parsed.project) {
    const selected = graph.context.project
    if (selected?.kind !== 'registered' || selected.name !== parsed.project)
      throw new TokenResolutionError(
        `Address ${inlineCodeText(address)} contradicts the selected project; select ${inlineCodeText(parsed.project)} explicitly instead of mixing scopes.`,
      )
  }
  return parsed.path
}

function metadata(token: EffectiveToken) {
  if (typeof token.value === 'string') return { description: undefined, tags: undefined, arguments: [] }
  return {
    description: token.value.$description,
    tags: token.value.$tags,
    arguments: token.value.$type === 'prompt' ? [] : (token.value.$arguments ?? []),
  }
}

/** A string whose whole value is one reference is an alias. */
export function aliasTarget(value: string) {
  const parts = contentParts(value)
  const first = parts[0]
  return parts.length === 1 && first?.kind === 'reference' ? first.path : undefined
}

export function enumerateEffectiveTokens(graph: TokenGraph) {
  return [...graph.tokens.values()].map(token => {
    const alias = typeof token.value === 'string' ? aliasTarget(token.value) : undefined
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
  const lookupSecret = createSecretLookup()
  const secretEnvironments = new Map<string, NodeJS.ProcessEnv>()
  const traces = new Map<
    string,
    {
      path: string
      origin: 'root' | 'project'
      source: ConfigurationSource
      description: string | undefined
      tags: string[] | undefined
      arguments: { name: string; description?: string }[]
      references: string[]
      deferred: string[]
      files: ResourceLocation[]
      privatePlaceholder: boolean
      secrets: SecretBindings
      overridden: { path: string; source: ConfigurationSource } | undefined
    }
  >()
  const inspected: typeof traces = new Map()
  const payloads = new Map<string, { content: string; provenance: ResourceLocation }>()
  const evaluations = new Map<string, Promise<string>>()

  function location(reference: string, token: EffectiveToken) {
    if (token.origin === 'root' && reference.startsWith('<repo>/'))
      throw new TokenResolutionError(
        `Global token ${inlineCodeText(token.path)} cannot depend on repository resource ${inlineCodeText(reference)}.`,
      )
    const checkoutRoot = graph.context.checkoutRoot
    const project = graph.context.project
    if (reference.startsWith('<repo>/') && !checkoutRoot)
      throw new TokenResolutionError(
        `${inlineCodeText(token.path)} reads ${inlineCodeText(reference)}, but ${project?.name ? `project ${inlineCodeText(project.name)} has no base path on this machine` : 'no checkout is available'}.`,
      )
    return load(token, () => resolveResourceLocation(reference, checkoutRoot ? { repoRoot: checkoutRoot } : {}))
  }

  // A file that cannot load is a problem of the token that names it.
  function load<Result>(token: EffectiveToken, run: () => Result) {
    try {
      return run()
    } catch (error) {
      if (!(error instanceof ResourceLoadError)) throw error
      throw new TokenResolutionError(
        `${inlineCodeText(token.path)} in ${inlineCodeText(token.source.file)} cannot load ${inlineCodeText(error.reference)}: ${error.detail}`,
      )
    }
  }

  function prompt(token: EffectiveToken) {
    if (typeof token.value !== 'string' && token.value.$type !== 'prompt')
      throw new TokenResolutionError(`Token ${inlineCodeText(token.path)} is not a prompt.`)
    const authored = typeof token.value === 'string' ? token.value : token.value.$exec
    if (!isMarkedResourceReference(authored)) return { content: authored, parts: contentParts(authored), files: [] }
    const provenance = location(authored, token)
    const cached = payloads.get(authored)
    if (cached) return { content: cached.content, parts: contentParts(cached.content), files: [cached.provenance] }
    const checkoutRoot = graph.context.checkoutRoot
    const content = load(token, () =>
      readMarkedResource(authored, checkoutRoot ? { repoRoot: checkoutRoot } : {}),
    ).content
    payloads.set(authored, { content, provenance })
    return { content, parts: contentParts(content), files: [provenance] }
  }

  function missing(path: string, chain: string[], token: EffectiveToken | undefined): never {
    const referrer = chain.at(-1)
    const file = token ? ` in ${inlineCodeText(token.source.file)}` : ''
    const reference = referrer ? ` ${inlineCodeText(referrer)}${file} references it.` : ''
    if (graph.rootNamespaces.has(path) || graph.projectNamespaces.has(path))
      throw new TokenResolutionError(`${inlineCodeText(path)} is a namespace, not a token.${reference}`)
    if (token?.origin === 'root' && graph.context.project && !graph.rootTokens.has(path))
      throw new TokenResolutionError(
        `Shared token ${inlineCodeText(token.path)} depends on project-only token ${inlineCodeText(path)}.`,
      )
    throw new TokenResolutionError(`Token ${inlineCodeText(path)} does not exist.${reference}`)
  }

  function inspect(path: string) {
    const cached = inspected.get(path)
    if (cached) return cached
    const token = graph.tokens.get(path)
    if (!token) return missing(path, [], undefined)

    const references: string[] = []
    const deferred: string[] = []
    const files: ResourceLocation[] = []
    let privatePlaceholder: boolean
    if (typeof token.value === 'string' || token.value.$type === 'prompt') {
      const loaded = prompt(token)
      privatePlaceholder = loaded.parts.some(part => part.kind === 'private')
      files.push(...loaded.files)
      for (const part of loaded.parts)
        if (part.kind === 'reference') references.push(part.path)
        else if (part.kind === 'deferred') deferred.push(part.path)
    } else {
      privatePlaceholder = hasPrivatePlaceholder(token.value)
      const executions = Array.isArray(token.value.$exec) ? token.value.$exec : [token.value.$exec]
      for (const exec of executions) {
        if (privatePlaceholder) break
        if (!isMarkedResourceReference(exec)) continue
        files.push(location(exec, token))
      }
    }

    const trace = {
      path,
      origin: token.origin,
      source: token.source,
      ...metadata(token),
      references,
      deferred,
      files,
      privatePlaceholder,
      secrets: typeof token.value === 'string' ? {} : (token.value.$secrets ?? {}),
      overridden: token.overridden ? { path: token.overridden.path, source: token.overridden.source } : undefined,
    }
    inspected.set(path, trace)
    return trace
  }

  function check(path: string, chain: string[]) {
    const token = graph.tokens.get(path)
    if (!token) return missing(path, chain, chain.length ? graph.tokens.get(chain.at(-1)!) : undefined)
    const trace = inspect(path)
    for (const target of [...trace.references, ...trace.deferred])
      if (!graph.tokens.has(target) || (token.origin === 'root' && !graph.rootTokens.has(target)))
        missing(target, [...chain, path], token)
    if (!secretEnvironments.has(path))
      secretEnvironments.set(path, resolveSecretBindings(path, trace.secrets, lookupSecret))
    return trace
  }

  function visit(path: string, chain: string[]) {
    if (chain.includes(path))
      throw new TokenResolutionError(`Circular token reference: ${inlineCodeText([...chain, path].join(' -> '))}`)
    if (traces.has(path)) return
    const trace = check(path, chain)
    for (const target of trace.references) visit(target, [...chain, path])
    traces.set(path, trace)
  }

  async function evaluate(path: string): Promise<string> {
    const cached = evaluations.get(path)
    if (cached) return cached
    const pending = (async () => {
      const token = graph.tokens.get(path)!
      if (typeof token.value !== 'string' && token.value.$type !== 'prompt') {
        if (hasPrivatePlaceholder(token.value)) return renderTemplateFile('private-value', { path })
        if (!evaluateScript)
          throw new TokenResolutionError(`Computed token ${inlineCodeText(path)} requires an evaluation hook.`)
        const resource = token.value as ScriptResource
        const executions = Array.isArray(resource.$exec) ? resource.$exec : [resource.$exec]
        const locations = executions.map(exec => (isMarkedResourceReference(exec) ? location(exec, token) : undefined))
        const output = await evaluateScript({
          token,
          resource,
          locations,
          secretEnvironment: secretEnvironments.get(path)!,
        })
        if (typeof output !== 'string')
          throw new TokenResolutionError(`Computed token ${inlineCodeText(path)} returned non-text output.`)
        return output
      }
      const loaded = prompt(token)
      let output = ''
      for (const part of loaded.parts) {
        if (part.kind === 'literal') output += part.text
        else if (part.kind === 'private') output += renderTemplateFile('private-value', { path })
        else if (part.kind === 'deferred') {
          const project = graph.context.project
          const address = project?.kind === 'registered' ? `$projects.${project.name}.${part.path}` : part.path
          output += renderTemplateFile('deferred-reference', { path: address })
        } else output += await evaluate(part.path)
      }
      const secrets = typeof token.value === 'string' ? undefined : token.value.$secrets
      if (secrets && Object.keys(secrets).length) {
        const prefix = Object.entries(secrets)
          .map(([name, key]) => `${name}="$(woof secret ${key.startsWith('-') ? '-- ' : ''}${shellQuote(key)})"`)
          .join(' ')
        output = `${renderTemplateFile('secret-instructions', { path, bindings: secretBindingText(secrets), prefix })}\n\n${output}`
      }
      return output
    })()
    evaluations.set(path, pending)
    return pending
  }

  let evaluateScript: TokenEvaluator | undefined
  return {
    visit,
    inspect,
    check,
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

export async function resolveToken(
  graph: TokenGraph,
  address: string,
  evaluator?: TokenEvaluator,
  onPreflight?: (explanation: ReturnType<typeof preflightToken>) => void,
) {
  const path = graphAddress(graph, address)
  const walker = createWalker(graph)
  walker.setEvaluator(evaluator)
  walker.visit(path, [])
  onPreflight?.(explanation(graph, path, walker))
  return walker.evaluate(path)
}

export function preflightTokenGraph(graph: TokenGraph, addresses: string[]) {
  const walker = createWalker(graph)
  const pending = addresses.map(address => ({ path: graphAddress(graph, address), chain: '', expand: true }))
  const seen = new Set<string>()
  const expanded = new Set<string>()
  const tokens: ReturnType<typeof walker.inspect>[] = []
  const problems = new Map<string, string>()
  for (const { path, chain, expand } of pending) {
    try {
      if (!seen.has(path)) {
        seen.add(path)
        const token = walker.inspect(path)
        tokens.push(token)
        for (const [targets, arrow, expandTarget] of [
          [token.references, '->', false],
          [token.deferred, '~>', true],
        ] as const)
          for (const target of targets)
            if (graph.tokens.has(target))
              pending.push({ path: target, chain: `${chain || path} ${arrow} ${target}`, expand: expandTarget })
        if (!expand) walker.check(path, [])
      }
      // Expanding each immediate child again would repeat errors already reported by its ancestors.
      if (expand && !expanded.has(path)) {
        expanded.add(path)
        walker.visit(path, [])
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!problems.has(message)) problems.set(message, chain ? `${inlineCodeText(chain)}: ${message}` : message)
    }
  }
  return { tokens, problems: [...problems.values()] }
}
