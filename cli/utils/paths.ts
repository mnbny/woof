import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import manifest from '../../package.json' with { type: 'json' }

export function getWoofHome(...segments: string[]) {
  return join(process.env['WOOF_HOME']?.trim() || join(homedir(), '.woof'), ...segments)
}

let root: string | undefined

// The source entry and the bundle sit at different depths, so search upward. Only a directory with
// woof's own manifest counts, so a copied bundle never reads another project's files.
function findWoofRoot() {
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    try {
      const { name } = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { name?: unknown }
      if (name === manifest.name) return directory
    } catch {
      // A missing or unreadable manifest belongs to some other directory; keep searching.
    }
    const parent = dirname(directory)
    if (parent === directory)
      throw new Error('woof could not find its package root above the running entry. Reinstall or relink woof.')
    directory = parent
  }
}

export function getWoofRoot(...segments: string[]) {
  root ??= findWoofRoot()
  return join(root, ...segments)
}
