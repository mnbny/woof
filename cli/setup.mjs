#!/usr/bin/env node

// Keep the link outside versioned Node installations.

import { chmod, lstat, mkdir, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CI) {
  console.log('CI detected. Skipping woof link.')
  process.exit(0)
}

// The link runs the source entry, which needs the repository's dependencies.
const entry = join(dirname(fileURLToPath(import.meta.url)), 'woof.mjs')
const binDir = join(homedir(), '.local', 'bin')
const link = join(binDir, 'woof')

await chmod(entry, 0o755)
await mkdir(binDir, { recursive: true })

const existing = await lstat(link).catch(() => null)

if (existing && !existing.isSymbolicLink()) {
  console.error(`${link} exists and is not a symlink. woof was not linked.`)
  process.exit(0)
}

if (existing) await rm(link)
await symlink(entry, link)

console.log(`Linked woof to ${entry}`)

if (!(process.env.PATH ?? '').split(':').includes(binDir)) {
  console.warn(`${binDir} is not on your PATH. Add it to run woof.`)
}
