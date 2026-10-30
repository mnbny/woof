import { readFileSync } from 'node:fs'

import { getWoofHome } from './paths.ts'

export const DEFAULT_CONFIG = { schemaVersion: 1 }

export class WoofConfigUpgradeRequiredError extends Error {
  constructor(version: number) {
    super(
      `Config schema ${version} is newer than this CLI supports (${DEFAULT_CONFIG.schemaVersion}). Run woof upgrade and retry.`,
    )
  }
}

export function readWoofConfig(file = getWoofHome('woof.config.json')) {
  let source: string
  try {
    source = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw error
  }

  try {
    const data: unknown = JSON.parse(source)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Config must be an object.')
    const fields = data as Record<string, unknown>
    const version = fields['schemaVersion']
    if (typeof version === 'number' && Number.isInteger(version) && version > DEFAULT_CONFIG.schemaVersion)
      throw new WoofConfigUpgradeRequiredError(version)
    if (version !== DEFAULT_CONFIG.schemaVersion)
      throw new Error(`Config schemaVersion must be ${DEFAULT_CONFIG.schemaVersion}.`)
    const unknown = Object.keys(fields).filter(key => key !== 'schemaVersion')
    if (unknown.length) throw new Error(`Unknown config fields: ${unknown.join(', ')}.`)
    return { schemaVersion: version }
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}
