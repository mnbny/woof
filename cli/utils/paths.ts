import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function getWoofHome(...segments: string[]) {
  return join(process.env['WOOF_HOME']?.trim() || join(homedir(), '.woof'), ...segments)
}

// Source and bundled execution start at different depths in the checkout.
export function getWoofRoot() {
  let current = dirname(fileURLToPath(import.meta.url))

  while (!existsSync(join(current, 'package.json'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error('Could not find the Woof checkout. No package.json is above the CLI.')
    current = parent
  }

  const manifest: unknown = JSON.parse(readFileSync(join(current, 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object' || !('name' in manifest) || manifest.name !== 'woof')
    throw new Error('The running CLI is not inside a Woof checkout. Run upgrade from a Woof installation.')

  return current
}
