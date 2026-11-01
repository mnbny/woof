import type { Resource, TokenValue } from './schema.ts'

import { createHash } from 'node:crypto'

import { isPrivateToken } from './private.ts'
import { internalMarker, rewriteTokenReferences } from './tokens.ts'

export type ImportLeaf = string | Resource

export function flattenImportTokens(value: object) {
  const result = new Map<string, ImportLeaf>()
  function visit(node: object, prefix: string) {
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$')) continue
      const path = prefix ? `${prefix}.${key}` : key
      if (typeof child === 'string' || (child && typeof child === 'object' && ('$type' in child || '$exec' in child)))
        result.set(path, child as ImportLeaf)
      else if (child && typeof child === 'object') visit(child, path)
    }
  }
  visit(value, '')
  return result
}

export function importValueAt(value: object, path: string): unknown {
  let node: unknown = value
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, part)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}

export function putImportValue(value: Record<string, unknown>, path: string, incoming: unknown) {
  const parts = path.split('.')
  let node = value
  for (const part of parts.slice(0, -1)) {
    const next = node[part]
    if (next === undefined) node[part] = {}
    else if (!next || typeof next !== 'object' || Array.isArray(next) || '$type' in next || '$exec' in next)
      throw new Error(`Token address ${path} conflicts with the existing token ${part}.`)
    node = node[part] as Record<string, unknown>
  }
  node[parts.at(-1)!] = structuredClone(incoming)
}

export function assertImportAddress(path: string) {
  if (internalMarker(path)) throw new Error(`Token address ${path} is reserved for internal markers.`)
  if (
    !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(path) ||
    path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))
  )
    throw new Error(`Invalid token address: ${path}`)
}

export function rewriteImportToken(value: ImportLeaf, mappings: ReadonlyMap<string, string>): ImportLeaf {
  if (typeof value === 'string')
    return value.startsWith('<root>/') || value.startsWith('<repo>/') ? value : rewriteTokenReferences(value, mappings)
  if (value.$type === 'prompt' && !value.$exec.startsWith('<root>/') && !value.$exec.startsWith('<repo>/'))
    return { ...value, $exec: rewriteTokenReferences(value.$exec, mappings) }
  return value
}

export function importTokenFiles(value: ImportLeaf) {
  const exec = typeof value === 'string' ? [value] : Array.isArray(value.$exec) ? value.$exec : [value.$exec]
  return exec.filter(part => part.startsWith('<root>/') || part.startsWith('<repo>/'))
}

export function replaceImportTokenFiles(value: ImportLeaf, paths: ReadonlyMap<string, string>): ImportLeaf {
  if (typeof value === 'string') return paths.get(value) ?? value
  const replace = (part: string) => paths.get(part) ?? part
  return { ...value, $exec: Array.isArray(value.$exec) ? value.$exec.map(replace) : replace(value.$exec) } as ImportLeaf
}

export function rewriteImportPromptBytes(bytes: Uint8Array, mappings: ReadonlyMap<string, string>) {
  const content = Buffer.from(bytes).toString('latin1')
  const rewritten = rewriteTokenReferences(content, mappings)
  return rewritten === content ? bytes : Buffer.from(rewritten, 'latin1')
}

export function importTokenFingerprint(
  value: ImportLeaf,
  read: (reference: string) => Uint8Array | undefined,
  mappings: ReadonlyMap<string, string> = new Map(),
) {
  const prompt = typeof value === 'string' || value.$type === 'prompt'
  const type = typeof value === 'string' ? 'prompt' : value.$type
  const exec = typeof value === 'string' ? [value] : Array.isArray(value.$exec) ? value.$exec : [value.$exec]
  const parts: string[] = []
  for (const part of exec) {
    const file = part.startsWith('<root>/') || part.startsWith('<repo>/')
    const bytes = file ? read(part) : new TextEncoder().encode(part)
    if (!bytes) return undefined
    const content = prompt ? rewriteImportPromptBytes(bytes, mappings) : bytes
    const hash = createHash('sha256').update(content).digest('hex')
    parts.push(`${prompt ? '' : file ? 'file:' : 'inline:'}${hash}`)
  }
  return JSON.stringify({
    type,
    private: isPrivateToken(value),
    array: !prompt && typeof value !== 'string' && Array.isArray(value.$exec),
    parts,
  })
}

export function isImportLeaf(value: TokenValue | undefined): value is ImportLeaf {
  return (
    typeof value === 'string' || Boolean(value && typeof value === 'object' && ('$type' in value || '$exec' in value))
  )
}
