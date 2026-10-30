#!/usr/bin/env node

// Keep the link outside versioned Node installations.

import { appendFile, chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.CI) {
  console.log('CI detected. Skipping woof link.')
  process.exit(0)
}

// A consumer clones the repository and runs nothing else, so the default entry is the bundle, which
// needs no install. The development entry needs the repository's dependencies.
const developing = process.argv.includes('--dev')
const cliDirectory = dirname(fileURLToPath(import.meta.url))
const entry = join(cliDirectory, developing ? 'woof.mjs' : 'woof.bundle.mjs')
const binDir = join(homedir(), '.local', 'bin')
const link = join(binDir, 'woof')

if (!(await lstat(entry).catch(() => null))) {
  console.error(
    `${entry} is missing. ${developing ? 'Run `pnpm build`.' : 'Re-clone, or run `pnpm install && pnpm build`.'}`,
  )
  process.exit(1)
}

await chmod(entry, 0o755)
await mkdir(binDir, { recursive: true })

const existing = await lstat(link).catch(() => null)

if (existing && !existing.isSymbolicLink()) {
  console.error(`${link} exists and is not a symlink. woof was not linked.`)
  process.exit(0)
}

if (existing) await rm(link)
await symlink(entry, link)

console.log(`Linked woof to ${entry}${developing ? ' (development entry)' : ''}`)

if (!(process.env.PATH ?? '').split(':').includes(binDir)) {
  console.warn(`${binDir} is not on your PATH. Add it to run woof.`)
}

const shell = basename(process.env.SHELL ?? '')
const rcFiles = { bash: '.bashrc', zsh: '.zshrc' }
const rcFile = rcFiles[shell]
const previousCompletionLine = `command -v woof >/dev/null && source <(woof complete ${shell}) || true`
const completionLine =
  shell === 'zsh'
    ? 'command -v woof >/dev/null && command -v compdef >/dev/null && source <(woof complete zsh) || true'
    : previousCompletionLine

if (rcFile) {
  const rcPath = join(homedir(), rcFile)
  const rc = await readFile(rcPath, 'utf8').catch(() => '')
  const lines = rc.split('\n')
  const updated = lines.map(line => (line === previousCompletionLine ? completionLine : line)).join('\n')

  if (updated !== rc) {
    await writeFile(rcPath, updated)
    console.log(`Updated ${shell} completions in ${rcPath}. Restart your shell to use them.`)
  } else if (lines.includes(completionLine)) {
    console.log(`Shell completions already enabled in ${rcPath}`)
  } else {
    const separator = rc === '' || rc.endsWith('\n') ? '' : '\n'
    await appendFile(rcPath, `${separator}${completionLine}\n`)
    console.log(`Enabled ${shell} completions in ${rcPath}. Restart your shell to use them.`)
  }
} else {
  const name = shell || 'your shell'
  console.log(
    `No completion setup for ${name}. \`woof complete <shell>\` emits a script for zsh, bash, fish, or powershell; register it the way ${name} expects.`,
  )
}
