import { randomUUID } from 'node:crypto'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import template from '../templates/woof.config.json' with { type: 'json' }
import { getWoofHome } from './paths.ts'

export async function initializeWoofHome(file = getWoofHome('woof.config.json')) {
  const temporary = join(dirname(file), `.woof.config.${process.pid}.${randomUUID()}.tmp`)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, `${JSON.stringify(template, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    })
    await link(temporary, file)
    return { file, created: true }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { file, created: false }
    throw new Error(`Could not initialize personal configuration at ${file}.`, { cause: error })
  } finally {
    await rm(temporary, { force: true })
  }
}
