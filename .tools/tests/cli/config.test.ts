import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, lstat, mkdir, readdir, readFile } from 'node:fs/promises'
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

function run(cli: Cli, home: string, args: string[], cwd = cli.project) {
  assert(home.includes('woof-test-'), 'WOOF_HOME must belong to the test fixture')
  return cli.run(process.execPath, [cli.entry, ...args], cwd, {
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

test('checks registered configuration globally without reading payloads', async ({ cli, directory, expect }) => {
  const home = join(directory, 'global-home')
  const root = join(home, 'woof.config.json')
  const project = join(home, 'project.json')
  await put(
    root,
    JSON.stringify({
      $schemaVersion: 2,
      instructions: '<root>/missing-payload.txt',
      $projects: { unrelated: '<root>/project.json' },
    }),
  )
  await put(project, '{"$schemaVersion":3}\n')

  for (const args of [['--help'], ['get', 'instructions', '--project', 'unrelated'], ['projects', '--migrate']]) {
    expect((await run(cli, home, args)).status).toBe(1)
  }
  expect(await readFile(project, 'utf8')).toBe('{"$schemaVersion":3}\n')
  await put(project, '{"$schemaVersion":2}\n')
  expect((await run(cli, home, ['--help'])).status).toBe(0)
})

test('rejects checkout-relative registered project configuration on startup', async ({ cli, directory, expect }) => {
  const home = join(directory, 'registered-checkout-config')
  const root = join(home, 'woof.config.json')
  const original = JSON.stringify({ $schemaVersion: 2, $projects: { demo: '<repo>/project.json' } })
  await put(root, original)
  const result = await run(cli, home, ['--help'])
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('must be inline or reference a <root>/ configuration file')
  expect(await readFile(root, 'utf8')).toBe(original)
})

test('registers a home project in place and never replaces one', async ({ cli, directory, expect }) => {
  const home = join(directory, 'init-home')
  const file = join(home, 'woof.config.json')
  await put(file, '{"$schemaVersion":2,"shared":"x","$projects":{"old":{}},"tail":"y"}\n')
  await chmod(file, 0o600)
  const register = ['init', '--name', 'acme', '--agent']

  expect((await run(cli, home, [...register, '--base-path', '~/work/acme'])).status).toBe(0)
  const registered = await readFile(file, 'utf8')
  expect(Object.keys(JSON.parse(registered))).toEqual(['$schemaVersion', 'shared', '$projects', 'tail'])
  expect(JSON.parse(registered).$projects).toEqual({ old: {}, acme: { $metadata: { $basePaths: ['~/work/acme'] } } })
  expect((await lstat(file)).mode & 0o777).toBe(0o600)

  expect((await run(cli, home, register)).status).toBe(1)
  expect(await readFile(file, 'utf8')).toBe(registered)
  expect(await readdir(home)).toEqual(['woof.config.json'])
})

test('creates one repository configuration per checkout', async ({ cli, directory, expect }) => {
  const home = join(directory, 'init-repository-home')
  const checkout = join(directory, 'init-checkout')
  await mkdir(checkout)
  execFileSync('git', ['init', '-q', checkout])

  expect((await run(cli, home, ['init', '--repo', '.agents/woof.config.json', '--agent'], checkout)).status).toBe(0)
  expect(JSON.parse(await readFile(join(checkout, '.agents/woof.config.json'), 'utf8'))).toEqual({ $schemaVersion: 2 })
  expect((await run(cli, home, ['init', '--repo', 'woof.config.json', '--agent'], checkout)).status).toBe(1)
  await expect(lstat(join(checkout, 'woof.config.json'))).rejects.toThrow()
})

test('adds a token only when the whole configuration still works', async ({ cli, directory, expect }) => {
  const home = join(directory, 'add-home')
  const file = join(home, 'woof.config.json')
  await put(
    file,
    JSON.stringify({
      $schemaVersion: 2,
      conventions: { commit: { default: 'seven rules' } },
      $projects: { acme: { agents: { local: 'acme agents' } } },
    }),
  )
  const original = await readFile(file, 'utf8')
  const add = (path: string, content: string) =>
    run(cli, home, ['add', '--type', 'prompt', '--shared', '--content', content, '--agent', '--', path])

  expect((await add('agents', 'a shared leaf over a project namespace')).status).toBe(1)
  expect((await add('broken', 'see {{missing}}')).status).toBe(1)
  expect((await add('conventions.commit.default', 'a duplicate')).status).toBe(1)
  for (const path of ['-x-', '-nested.value-']) {
    const rejected = await add(path, 'cannot be referenced')
    expect(rejected.status).toBe(1)
    expect(rejected.stdout).toContain('reserved for internal markers')
  }
  expect(await readFile(file, 'utf8')).toBe(original)

  expect((await add('conventions.commit.short', 'Keep {{conventions.commit.default}} short.')).status).toBe(0)
  const added = JSON.parse(await readFile(file, 'utf8'))
  expect(added.conventions.commit).toEqual({
    default: 'seven rules',
    short: 'Keep {{conventions.commit.default}} short.',
  })
  expect(added.$projects).toEqual({ acme: { agents: { local: 'acme agents' } } })
  expect((await add('conventions.-draft-', 'valid nested name')).status).toBe(0)
  expect((await add('draft', '{{conventions.-draft-}}')).status).toBe(0)
  expect((await run(cli, home, ['get', 'draft', '--agent'])).stdout).toBe('valid nested name')
})

test('copies a file from outside woof home so that the new token resolves', async ({ cli, directory, expect }) => {
  const home = join(directory, 'add-copy-home')
  const source = join(directory, 'outside', 'rule.md')
  await put(join(home, 'woof.config.json'), JSON.stringify({ $schemaVersion: 2, base: 'seven rules' }))
  await put(source, 'Use {{base}}.\n')

  const added = await run(cli, home, [
    'add',
    'rules.commit',
    '--type',
    'prompt',
    '--shared',
    '--content',
    source,
    '--agent',
  ])
  expect(added.status).toBe(0)
  expect(JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8')).rules).toEqual({
    commit: '<root>/resources/rules/commit.md',
  })
  expect((await run(cli, home, ['get', 'rules.commit', '--agent'])).stdout).toBe('Use seven rules.\n')
  expect(await readFile(source, 'utf8')).toBe('Use {{base}}.\n')
})

test('edits a prompt file in place, or overrides it without touching the shared file', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'edit-home')
  const acme = join(directory, 'acme')
  const root = join(home, 'woof.config.json')
  const prompt = join(home, 'prompts', 'rule.md')
  await put(
    root,
    JSON.stringify({
      $schemaVersion: 2,
      base: 'seven rules',
      rule: '<root>/prompts/rule.md',
      $projects: { acme: { $metadata: { $basePaths: [acme] } } },
    }),
  )
  await put(prompt, 'Use {{base}}.\n')
  await mkdir(acme)
  const original = await readFile(root, 'utf8')

  expect((await run(cli, home, ['edit', 'rule', '--content', 'Follow {{base}}.', '--agent'])).status).toBe(0)
  expect(await readFile(prompt, 'utf8')).toBe('Follow {{base}}.')
  expect(await readFile(root, 'utf8')).toBe(original)

  expect((await run(cli, home, ['edit', 'rule', '--content', 'Acme only.', '--agent'], acme)).status).toBe(1)
  expect(
    (await run(cli, home, ['edit', 'rule', '--override', '--content', 'Acme only.', '--agent'], acme)).status,
  ).toBe(0)
  expect(JSON.parse(await readFile(root, 'utf8')).$projects.acme.rule).toBe('Acme only.')
  expect(await readFile(prompt, 'utf8')).toBe('Follow {{base}}.')

  const edited = await readFile(root, 'utf8')
  expect((await run(cli, home, ['edit', 'rule', '--content', 'See {{missing}}.', '--agent'])).status).toBe(1)
  expect(await readFile(prompt, 'utf8')).toBe('Follow {{base}}.')
  expect(await readFile(root, 'utf8')).toBe(edited)
})
