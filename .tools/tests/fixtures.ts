import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inject, test as baseTest } from 'vitest'

declare module 'vitest' {
  interface ProvidedContext {
    cliSource: string
  }
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export async function put(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

export const test = baseTest
  // eslint-disable-next-line no-empty-pattern -- Vitest requires destructured fixture dependencies.
  .extend('directory', async ({}, { onCleanup }) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'woof-test-')))
    onCleanup(() => rm(directory, { recursive: true, force: true }))
    return directory
  })
  .extend('cli', async ({ directory }) => {
    const checkout = join(directory, 'checkout')
    const bin = join(directory, 'bin')
    const project = join(directory, 'project')
    const taskHome = join(directory, "developer's $HOME `literal`")
    // Laid out like the installed package, which has no node_modules.
    const bundleDirectory = join(directory, 'standalone')
    const entry = join(bundleDirectory, 'cli', 'woof.bundle.mjs')
    const sourceEntry = join(checkout, 'cli', 'woof.mjs')
    const checkoutEntry = join(checkout, 'cli', 'woof.bundle.mjs')
    const env = {
      HOME: taskHome,
      PATH: `${bin}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    }

    await Promise.all([taskHome, project, bin, dirname(entry)].map(path => mkdir(path, { recursive: true })))
    await cp(join(repoRoot, 'cli'), join(checkout, 'cli'), {
      recursive: true,
      filter: path => basename(path) !== 'woof.bundle.mjs',
    })
    await cp(join(repoRoot, 'package.json'), join(checkout, 'package.json'))
    await symlink(join(repoRoot, 'node_modules'), join(checkout, 'node_modules'))
    await cp(join(repoRoot, 'package.json'), join(bundleDirectory, 'package.json'))
    await cp(join(repoRoot, 'cli', 'templates'), join(bundleDirectory, 'cli', 'templates'), { recursive: true })
    await writeFile(entry, inject('cliSource'))
    await writeFile(checkoutEntry, inject('cliSource'))

    function run(file: string, args: string[], cwd = project, markers: NodeJS.ProcessEnv = {}, timeout = 5_000) {
      return new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
        execFile(
          file,
          args,
          { cwd, env: { ...env, ...markers }, encoding: 'utf8', timeout },
          (error, stdout, stderr) => {
            if (!error) resolve({ status: 0, stdout, stderr })
            else if (typeof error.code === 'number') resolve({ status: error.code, stdout, stderr })
            else reject(error)
          },
        )
      })
    }

    return { bin, checkout, checkoutEntry, entry, project, run, sourceEntry, taskHome }
  })
