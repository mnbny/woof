import type { Resource } from './schema.ts'

export const PRIVATE_MARKER = '{{-woof:private-}}'

export function isPrivateToken(value: string | Resource) {
  return typeof value !== 'string' && value.$private === true
}

export function hasPrivatePlaceholder(value: string | Resource) {
  if (typeof value === 'string' || value.$type === 'prompt') {
    const content = typeof value === 'string' ? value : value.$exec
    // Keep marker detection consistent with the resolver's escaping rules.
    return /(?<![${])\{\{-woof:private-\}\}(?!\})/.test(content)
  }
  // Script source is opaque. Only a whole execution entry can be a placeholder.
  return (Array.isArray(value.$exec) ? value.$exec : [value.$exec]).includes(PRIVATE_MARKER)
}
