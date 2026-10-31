import { chmod, lstat, mkdir, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

type Cli = {
  entry: string
  project: string
  run(
    file: string,
    args: string[],
    cwd?: string,
    markers?: NodeJS.ProcessEnv,
    timeout?: number,
  ): Promise<{ status: number; stdout: string; stderr: string }>
}

function run(cli: Cli, home: string, args: string[]) {
  return cli.run(process.execPath, [cli.entry, ...args], cli.project, {
    WOOF_HOME: home,
    NO_COLOR: '1',
    TERM: 'dumb',
  })
}

test('creates a complete current config once across concurrent first launches', async ({ cli, directory, expect }) => {
  const home = join(directory, 'home')
  const file = join(home, 'woof.config.json')
  const launches = await Promise.all(Array.from({ length: 8 }, () => run(cli, home, ['validate'])))

  for (const launch of launches) expect(launch.status).toBe(0)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ $schemaVersion: 2 })
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  expect(await readdir(home)).toEqual(['woof.config.json'])
})

test('migrates the known legacy format while preserving its link and mode', async ({ cli, directory, expect }) => {
  const home = join(directory, 'home')
  const target = join(directory, 'legacy.json')
  const file = join(home, 'woof.config.json')
  await mkdir(home, { recursive: true })
  await writeFile(target, '{"schemaVersion":1}\n')
  await chmod(target, 0o640)
  await symlink(target, file)

  expect((await run(cli, home, ['validate'])).status).toBe(1)
  expect((await run(cli, home, ['--migrate'])).status).toBe(1)
  expect((await run(cli, home, ['validate', '--migrate', '--unknown'])).status).toBe(1)
  expect(await readFile(target, 'utf8')).toBe('{"schemaVersion":1}\n')

  expect((await run(cli, home, ['validate', '--migrate'])).status).toBe(0)
  expect((await lstat(file)).isSymbolicLink()).toBe(true)
  expect((await lstat(target)).mode & 0o777).toBe(0o640)
  expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ $schemaVersion: 2 })
  expect(await readdir(home)).toEqual(['woof.config.json'])
})

test('rejects unversioned, future and invalid configurations without rewriting them', async ({
  cli,
  directory,
  expect,
}) => {
  for (const [name, source] of [
    ['unversioned', '{"token":"keep"}\n'],
    ['future', '{"$schemaVersion":3}\n'],
  ] as const) {
    const home = join(directory, name)
    const file = join(home, 'woof.config.json')
    await put(file, source)
    const result = await run(cli, home, ['validate', '--migrate'])
    expect(result.status).toBe(1)
    expect(await readFile(file, 'utf8')).toBe(source)
  }

  const home = join(directory, 'unversioned-project')
  const file = join(home, 'woof.config.json')
  const original = '{"$schemaVersion":2,"$projects":{"broken":"<root>/broken.json"}}\n'
  await put(file, original)
  await put(join(home, 'broken.json'), '{"unversioned":true}\n')
  const selected = await run(cli, home, ['validate', '--project', 'broken', '--migrate'])
  expect(selected.status).toBe(1)
  expect(await readFile(file, 'utf8')).toBe(original)
})
