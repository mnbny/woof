import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import template from '../templates/woof.config.json' with { type: 'json' }
import { serializeConfigurationDocument } from './config.ts'
import { getWoofHome } from './paths.ts'
import { SECRETS_FILE } from './secrets.ts'

async function initializeFile(file: string, content: string) {
  try {
    await lstat(file)
    return { file, created: false }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, content, {
      flag: 'wx',
      mode: 0o600,
    })
    await link(temporary, file)
    return { file, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { file, created: false }
    throw new Error(`Could not initialize personal file at ${file}.`, { cause: error })
  } finally {
    await rm(temporary, { force: true })
  }
}

export async function initializeWoofHome(file = getWoofHome('woof.config.json')) {
  const configuration = await initializeFile(file, serializeConfigurationDocument(template))
  try {
    await initializeFile(join(dirname(file), SECRETS_FILE), '{}\n')
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : error
    // A read-only home must not block tokens that do not need secrets.
    if (!['EACCES', 'EPERM', 'EROFS'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw error
  }
  return configuration
}
