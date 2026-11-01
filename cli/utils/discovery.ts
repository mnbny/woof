import type { createTokenGraph } from './tokens.ts'

import { picoSearch } from '@chatwoot/pico-search'

import { enumerateEffectiveTokens } from './tokens.ts'

type TokenGraph = ReturnType<typeof createTokenGraph>

export function discoverResources(graph: TokenGraph, query = '') {
  const tokens = enumerateEffectiveTokens(graph)
  const normalized = query.trim()
  // The full list shows the project tokens first, because they are the most specific, then the shared tokens.
  if (!normalized)
    return tokens.sort(
      (left, right) =>
        Number(left.origin === 'root') - Number(right.origin === 'root') || left.path.localeCompare(right.path),
    )

  const records = tokens.map(token => ({
    token,
    path: token.path,
    description: token.description ?? '',
    tags: (token.tags ?? []).join(' '),
    target: token.target ?? '',
  }))
  // pico-search averages fields for one word, so search each field separately and keep each token's best hit.
  const matches =
    normalized.split(/\s+/).length === 1
      ? picoSearch(
          records.flatMap(({ token, ...fields }) =>
            Object.values(fields)
              .filter(value => value.trim())
              .map(value => ({ token, value })),
          ),
          normalized,
          ['value'],
          { threshold: 0.3 },
        )
      : picoSearch(records, normalized, ['path', 'description', 'tags', 'target'], { threshold: 0.3 })
  return [...new Set(matches.map(record => record.token))].sort(
    (left, right) => Number(left.origin === 'root') - Number(right.origin === 'root'),
  )
}
