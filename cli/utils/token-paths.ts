export function tokenValueAt(value: object, path: string) {
  let node: unknown = value
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || !Object.hasOwn(node, part)) return undefined
    node = (node as Record<string, unknown>)[part]
  }
  return node
}
