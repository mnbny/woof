import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { chmod, lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

import { createBundleArchive, readBundleArchive } from '../../../cli/utils/bundles.ts'
import { validateConfigurationDocument } from '../../../cli/utils/config.ts'
import { applyImport, ImportApplyError } from '../../../cli/utils/import-apply.ts'
import { planImport, reviewImport } from '../../../cli/utils/import-plan.ts'
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
  assert(home.includes('woof-test-'), 'WOOF_HOME must belong to the test fixture')
  return cli.run(process.execPath, [cli.entry, ...args], cli.project, {
    WOOF_HOME: home,
    NO_COLOR: '1',
    TERM: 'dumb',
  })
}

async function config(home: string, value: unknown) {
  await put(join(home, 'woof.config.json'), JSON.stringify(value))
}

function rootConfiguration(value: unknown) {
  return validateConfigurationDocument(value, 'root', 'transfer fixture')
}

test('redacts private values and files from raw exports and preserves placeholders across import and editing', async ({
  cli,
  directory,
  expect,
}) => {
  const marker = '{{-woof:private-}}'
  execFileSync('git', ['init', '-q', cli.project])
  await put(join(cli.project, 'accounts.txt'), 'checkout:private-password')
  await put(join(cli.project, 'run.js'), 'throw new Error("private-script-source")')
  for (const separate of [false, true]) {
    const source = join(directory, `source-${separate}`)
    const destination = join(directory, `destination-${separate}`)
    const project = {
      $metadata: { $basePaths: [cli.project] },
      account: {
        $type: 'prompt',
        $private: true,
        $description: 'Staging accounts',
        $tags: ['e2e'],
        $exec: '<repo>/accounts.txt',
      },
      script: { $type: 'node', $private: true, $exec: ['<repo>/run.js', 'throw new Error("private-inline-script")'] },
      shadowed: 'public override',
      instructions: 'Sign in with {{account}}. Use {{shared}} {{file}} {{public}}.',
    }
    await config(source, {
      $schemaVersion: 2,
      shared: { $type: 'prompt', $private: true, $exec: 'shared:private-password' },
      file: { $type: 'prompt', $private: true, $exec: '<root>/account.txt' },
      shadowed: { $type: 'prompt', $private: true, $exec: 'shadowed:private-password' },
      public: { $type: 'prompt', $private: false, $exec: '<root>/public.txt' },
      $projects: { demo: separate ? '<root>/project.json' : project },
    })
    if (separate) await put(join(source, 'project.json'), JSON.stringify({ $schemaVersion: 2, ...project }))
    await put(join(source, 'account.txt'), 'file:private-password')
    await put(join(source, 'public.txt'), 'public payload')
    const original = await readFile(join(source, 'woof.config.json'))
    const originalProject = separate ? await readFile(join(source, 'project.json')) : undefined
    const exported = await run(cli, source, ['export', '--project', 'demo', '--agent'])
    expect(exported.status, exported.stdout).toBe(0)
    const archivePath = /^Archive: (.+)$/m.exec(exported.stdout)?.[1]
    assert(archivePath)
    const archive = await readFile(archivePath)
    const raw = unzipSync(archive)
    // Inspect every ZIP entry, including entries the bundle reader would otherwise ignore.
    expect(Object.keys(raw).sort()).toEqual(
      ['woof.config.json', 'public.txt', ...(separate ? ['project.json'] : [])].sort(),
    )
    for (const bytes of Object.values(raw)) {
      const content = strFromU8(bytes)
      expect(content).not.toContain('private-password')
      expect(content).not.toContain('private-script-source')
      expect(content).not.toContain('private-inline-script')
    }
    const bundle = readBundleArchive(archive)
    expect(bundle.configuration['shared']).toMatchObject({ $private: true, $exec: marker })
    expect(bundle.configuration['file']).toMatchObject({ $private: true, $exec: marker })
    expect(bundle.configuration['shadowed']).toBeUndefined()
    expect(bundle.project['account']).toEqual({ ...project.account, $exec: marker })
    expect(bundle.project['script']).toEqual({ ...project.script, $exec: marker })
    expect(await readFile(join(source, 'woof.config.json'))).toEqual(original)
    if (separate) expect(await readFile(join(source, 'project.json'))).toEqual(originalProject)
    expect(await readFile(join(source, 'account.txt'), 'utf8')).toBe('file:private-password')
    expect(await readFile(join(cli.project, 'accounts.txt'), 'utf8')).toBe('checkout:private-password')

    await config(destination, { $schemaVersion: 2, account: 'recipient shared default' })
    const imported = await run(cli, destination, ['import', archivePath, '--agent'])
    expect(imported.status, imported.stdout).toBe(0)
    expect(imported.stderr).toContain('shared: shared')
    expect(imported.stderr).toContain('demo: account')
    expect(JSON.parse(await readFile(join(destination, 'woof.config.json'), 'utf8')).account).toBe(
      'recipient shared default',
    )
    expect(fs.existsSync(join(destination, 'account.txt'))).toBe(false)
    expect((await run(cli, destination, ['get', 'instructions', '--project', 'demo'])).stdout).toContain(
      'Token "account" needs a value',
    )
    expect(
      (
        await run(cli, destination, [
          'edit',
          'account',
          '--project',
          'demo',
          '--content',
          'replacement:private-password',
          '--agent',
        ])
      ).status,
    ).toBe(0)
    expect(await run(cli, destination, ['get', 'account', '--project', 'demo'])).toMatchObject({
      status: 0,
      stdout: 'replacement:private-password',
      stderr: '',
    })
    const reexported = await run(cli, destination, ['export', '--project', 'demo', '--agent'])
    expect(reexported.status, reexported.stdout).toBe(0)
    const reexportPath = /^Archive: (.+)$/m.exec(reexported.stdout)?.[1]
    assert(reexportPath)
    expect(readBundleArchive(await readFile(reexportPath)).project['account']).toMatchObject({
      $private: true,
      $exec: marker,
    })
  }
})

test('redacts only marked tokens when other tokens read the same file or read configuration as text', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'explicit-private-home')
  const rawConfig = JSON.stringify({
    $schemaVersion: 2,
    account: { $type: 'prompt', $private: true, $exec: 'literal value inside a raw JSON file' },
  })
  await config(home, {
    $schemaVersion: 2,
    $projects: {
      demo: {
        privateAccount: { $type: 'prompt', $private: true, $exec: '<root>/accounts.txt' },
        publicAccount: '<root>/accounts.txt',
        debugConfig: '<root>/other.json',
      },
      other: '<root>/other.json',
    },
  })
  await put(join(home, 'accounts.txt'), 'explicitly exported by publicAccount')
  await put(join(home, 'other.json'), rawConfig)
  const result = await run(cli, home, ['export', '--project', 'demo', '--agent'])
  expect(result.status, result.stdout).toBe(0)
  const path = /^Archive: (.+)$/m.exec(result.stdout)?.[1]
  assert(path)
  const bundle = readBundleArchive(await readFile(path))
  expect(bundle.project['privateAccount']).toMatchObject({ $private: true, $exec: '{{-woof:private-}}' })
  expect(bundle.project['publicAccount']).toBe('<root>/accounts.txt')
  expect(strFromU8(bundle.files.get('accounts.txt')!)).toBe('explicitly exported by publicAccount')
  expect(bundle.project['debugConfig']).toBe('<root>/other.json')
  expect(strFromU8(bundle.files.get('other.json')!)).toBe(rawConfig)
  expect(bundle.configuration.$projects).not.toHaveProperty('other')
})

test('preserves an unchanged project config used as a prompt payload', async ({ cli, directory, expect }) => {
  const home = join(directory, 'config-payload-home')
  await config(home, { $schemaVersion: 2, $projects: { demo: '<root>/projects/demo.json' } })
  const project = {
    $schemaVersion: 2,
    a: 'A uses {{nested.b}}',
    nested: { b: 'B' },
    cfg: '<root>/projects/demo.json',
  }
  const original = `${JSON.stringify(project, null, 4).replaceAll('\n', '\r\n')}\r\n`
  const source = join(home, 'projects/demo.json')
  await put(source, original)

  const result = await run(cli, home, ['export', '--project', 'demo', '--agent'])
  expect(result.status, result.stdout).toBe(0)
  const path = /^Archive: (.+)$/m.exec(result.stdout)?.[1]
  assert(path)
  const raw = unzipSync(await readFile(path))
  expect(strFromU8(raw['projects/demo.json']!)).toBe(original)
  expect(await readFile(source, 'utf8')).toBe(original)
})

test('exports only reachable chains after overrides and redaction, keeping both imported scopes valid', async ({
  cli,
  directory,
  expect,
}) => {
  const source = join(directory, 'minimal-source')
  const destination = join(directory, 'minimal-destination')
  const project = {
    $schemaVersion: 2,
    entry: '{{common.wrapper}}',
    common: { style: 'project style' },
    hidden: { $type: 'prompt', $private: true, $exec: '{{dead}}' },
  }
  await config(source, {
    $schemaVersion: 2,
    common: {
      style: '<root>/unused-default.txt',
      message: '<root>/message.txt',
      wrapper: 'Wrapped: {{common.message}}',
      suffix: 'shared suffix',
      unrelated: '{{missing}}',
    },
    dead: '<root>/private-dependency.txt',
    $projects: { demo: '<root>/projects/demo.json', empty: {} },
  })
  await put(join(source, 'projects/demo.json'), JSON.stringify(project))
  await put(join(source, 'message.txt'), '{{common.style}} / {{common.suffix}}')
  const original = await readFile(join(source, 'woof.config.json'))
  const exported = await run(cli, source, ['export', '--project', 'demo', '--agent'])
  expect(exported.status, exported.stdout).toBe(0)
  const path = /^Archive: (.+)$/m.exec(exported.stdout)?.[1]
  assert(path)
  const archive = await readFile(path)
  expect(Object.keys(unzipSync(archive)).sort()).toEqual(['message.txt', 'projects/demo.json', 'woof.config.json'])
  const bundle = readBundleArchive(archive)
  expect(bundle.configuration).toEqual({
    $schemaVersion: 2,
    common: { suffix: 'shared suffix' },
    $projects: { demo: '<root>/projects/demo.json' },
  })
  expect(bundle.project).toEqual({
    ...project,
    common: { style: 'project style', message: '<root>/message.txt', wrapper: 'Wrapped: {{common.message}}' },
    hidden: { $type: 'prompt', $private: true, $exec: '{{-woof:private-}}' },
  })
  expect(strFromU8(bundle.files.get('message.txt')!)).toBe('{{common.style}} / {{common.suffix}}')
  expect(await readFile(join(source, 'woof.config.json'))).toEqual(original)
  expect(JSON.parse(await readFile(join(source, 'projects/demo.json'), 'utf8'))).toEqual(project)

  await config(destination, { $schemaVersion: 2 })
  const imported = await run(cli, destination, ['import', path, '--agent'])
  expect(imported.status, imported.stdout).toBe(0)
  for (const flags of [[], ['--project', 'demo']])
    expect((await run(cli, destination, ['validate', ...flags, '--agent'])).status).toBe(0)
  expect(await run(cli, destination, ['get', 'entry', '--project', 'demo'])).toMatchObject({
    status: 0,
    stdout: 'Wrapped: project style / shared suffix',
  })

  const empty = await run(cli, source, ['export', '--project', 'empty', '--agent'])
  expect(empty.status, empty.stdout).toBe(0)
  const emptyPath = /^Archive: (.+)$/m.exec(empty.stdout)?.[1]
  assert(emptyPath)
  const emptyArchive = await readFile(emptyPath)
  expect(Object.keys(unzipSync(emptyArchive))).toEqual(['woof.config.json'])
  expect(readBundleArchive(emptyArchive).configuration).toEqual({ $schemaVersion: 2, $projects: { empty: {} } })

  await put(join(source, 'projects/demo.json'), JSON.stringify({ ...project, entry: '{{missing}}' }))
  const invalid = await run(cli, source, ['export', '--project', 'demo', '--agent'])
  expect(invalid.status).toBe(1)
  expect(invalid.stdout).toContain('missing')
})

test('reviews incoming private placeholders against real local values without reusing unrelated placeholders', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'private-conflict-home')
  const marker = '{{-woof:private-}}'
  const placeholder = { $type: 'prompt', $private: true, $exec: marker }
  await config(home, {
    $schemaVersion: 2,
    account: { ...placeholder, $exec: 'keep:my-password' },
    unrelated: placeholder,
    $projects: { demo: { account: { ...placeholder, $exec: 'project:my-password' } } },
  })
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      account: placeholder,
      newAccount: placeholder,
      $projects: { demo: { account: placeholder } },
    }),
    [],
  )
  const path = join(directory, 'private.zip')
  await writeFile(path, archive)
  const before = await readFile(join(home, 'woof.config.json'))
  const first = await run(cli, home, ['import', path, '--agent'])
  expect(first.status).toBe(1)
  expect(first.stderr).toContain('private placeholders')
  expect(handoff(first.stdout).next).toMatchObject({ kind: 'token', path: 'account' })
  expect(handoff(first.stdout).next?.candidates).toBeUndefined()
  expect(await readFile(join(home, 'woof.config.json'))).toEqual(before)
  const reviewed: string[] = []
  const result = await reviewAgentImport(cli, home, path, join(directory, 'private-decisions.json'), item => {
    reviewed.push(`${item.kind}:${item.path}`)
    expect(item.candidates).toBeUndefined()
    return 'keep'
  })
  expect(result.status).toBe(0)
  expect(reviewed).toEqual(['token:account', 'project-token:account'])
  expect(await run(cli, home, ['get', 'account'])).toMatchObject({ status: 0, stdout: 'keep:my-password', stderr: '' })
  expect(await run(cli, home, ['get', 'account', '--project', 'demo'])).toMatchObject({
    status: 0,
    stdout: 'project:my-password',
    stderr: '',
  })
  expect((await run(cli, home, ['get', 'newAccount'])).stdout).toContain('needs a value')
})

function handoff(output: string) {
  const match = output.match(/\{\n {2}"archive":[\s\S]*?\n\}/)
  assert(match, output)
  return JSON.parse(match[0]) as {
    archive: string
    choices: Record<string, 'keep' | 'take' | { action: 'add' | 'reuse'; address: string }>
    next?: { id: string; kind: string; path: string; notice?: string; requiredNewPath?: boolean; candidates?: string[] }
    invalidated?: string[]
    conflicts: { id: string; kind: string; path: string }[]
  }
}

function ready(home: string, archive: Uint8Array, cwd: string) {
  const plan = planImport(archive, { home, cwd })
  const choices: Record<string, 'take'> = {}
  for (let count = 0; count < 100; count += 1) {
    const reviewed = reviewImport(plan, choices)
    if (reviewed.status === 'ready') return reviewed.candidate
    choices[reviewed.next.id] = 'take'
  }
  throw new Error('Import review did not finish.')
}

async function finishAgentImport(cli: Cli, home: string, archive: string, decisions: string) {
  for (let count = 0; count < 100; count += 1) {
    const result = await run(cli, home, [
      'import',
      archive,
      ...(fs.existsSync(decisions) ? ['--decisions', decisions] : []),
      '--agent',
    ])
    if (result.status === 0) return result
    const document = handoff(result.stdout)
    assert(document.next)
    document.choices[document.next.id] = document.next.path === 'b' ? 'keep' : 'take'
    await writeFile(decisions, JSON.stringify(document))
  }
  throw new Error('Agent import review did not finish.')
}

async function reviewAgentImport(
  cli: Cli,
  home: string,
  archive: string,
  decisions: string,
  choose: (
    item: NonNullable<ReturnType<typeof handoff>['next']>,
    document: ReturnType<typeof handoff>,
  ) => 'keep' | 'take' | { action: 'add' | 'reuse'; address: string },
) {
  for (let count = 0; count < 100; count += 1) {
    const result = await run(cli, home, [
      'import',
      archive,
      ...(fs.existsSync(decisions) ? ['--decisions', decisions] : []),
      '--agent',
    ])
    if (result.status === 0) return result
    const document = handoff(result.stdout)
    assert(document.next)
    document.choices[document.next.id] = choose(document.next, document)
    await writeFile(decisions, JSON.stringify(document))
  }
  throw new Error('Agent import review did not finish.')
}

test('round trips shared definitions and raw files without executing project scripts', async ({
  cli,
  directory,
  expect,
}) => {
  const source = join(directory, 'source-home')
  const destination = join(directory, 'destination-home')
  const marker = join(directory, 'computed-ran')
  const raw = Buffer.from([0xef, 0xbb, 0xbf, 0x73, 0x68, 0x61, 0x72, 0x65, 0x64, 0x0d, 0x0a])
  await config(source, {
    $schemaVersion: 2,
    conventions: { commit: '<root>/shared/commit.md' },
    agents: '{{conventions.commit}}',
    raw: '<root>/shared/raw.md',
    computed: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` },
    $projects: {
      demo: { conventions: { commit: 'project override' }, instructions: '{{agents}} {{raw}}', run: '{{computed}}' },
      other: { agents: 'other project', missing: '{{not-selected}}' },
    },
  })
  await mkdir(join(source, 'shared'), { recursive: true })
  await writeFile(join(source, 'shared/commit.md'), 'unused shared default')
  await writeFile(join(source, 'shared/raw.md'), raw)
  const original = await readFile(join(source, 'woof.config.json'))
  const exported = await run(cli, source, ['export', '--project', 'demo', '--agent'])
  expect(exported.status).toBe(0)
  const archivePath = /^Archive: (.+)$/m.exec(exported.stdout)?.[1]
  assert(archivePath, exported.stdout)
  const archive = await readFile(archivePath)
  const bundle = readBundleArchive(archive)
  expect(bundle.projectName).toBe('demo')
  expect(Object.keys(bundle.configuration.$projects!)).toEqual(['demo'])
  expect(bundle.files.has('manifest.json')).toBe(false)
  expect(bundle.files.has('shared/commit.md')).toBe(false)
  expect(bundle.configuration['conventions']).toBeUndefined()
  expect(bundle.configuration['agents']).toBeUndefined()
  expect(bundle.project['agents']).toBe('{{conventions.commit}}')
  expect(Buffer.from(bundle.files.get('shared/raw.md')!)).toEqual(raw)
  expect(await readFile(join(source, 'woof.config.json'))).toEqual(original)
  expect(fs.existsSync(marker)).toBe(false)

  await config(destination, { $schemaVersion: 2, $projects: { local: { agents: 'local project' } } })
  const imported = await finishAgentImport(cli, destination, archivePath, join(directory, 'roundtrip-decisions.json'))
  expect(imported.status).toBe(0)
  expect(await readFile(join(destination, 'shared/raw.md'))).toEqual(raw)
  expect(await run(cli, destination, ['get', 'agents', '--project', 'demo'])).toMatchObject({
    status: 0,
    stdout: 'project override',
  })
  expect(await run(cli, destination, ['get', 'raw'])).toMatchObject({
    status: 0,
    stdout: '\ufeffshared\r\n',
  })
  expect(await run(cli, destination, ['get', 'agents', '--project', 'local'])).toMatchObject({
    status: 0,
    stdout: 'local project',
  })
  expect((await run(cli, destination, ['get', 'agents', '--project', 'other'])).status).toBe(1)
  expect(fs.existsSync(marker)).toBe(false)
})

test('preserves mixed review choices and rejects stale state without partial application', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const marker = join(directory, 'review-script-ran')
  await config(home, {
    $schemaVersion: 2,
    a: 'old a',
    b: 'old b',
    payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
    $projects: { demo: { keep: 'local' }, other: { safe: 'yes' } },
  })
  await put(join(home, 'payload.txt'), 'local payload')
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      a: 'new a',
      b: 'new b',
      payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
      computed: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` },
      $projects: { demo: { keep: 'incoming', added: 'new' } },
    }),
    [{ path: 'payload.txt', data: new TextEncoder().encode('incoming payload') }],
  )
  const archivePath = join(directory, 'review.zip')
  await writeFile(archivePath, archive)
  const root = join(home, 'woof.config.json')
  const original = await readFile(root)

  const initial = await run(cli, home, ['import', archivePath, '--agent'])
  expect(initial.status).toBe(1)
  expect(await readFile(root)).toEqual(original)
  const decisions = handoff(initial.stdout)
  const decisionPath = join(directory, 'decisions.json')
  assert(decisions.next)
  const first = decisions.next
  expect(first.path).toBe('a')
  expect(decisions.choices).toEqual({})
  decisions.choices[first.id] = 'take'
  await writeFile(decisionPath, JSON.stringify(decisions))
  const second = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(second.status).toBe(1)
  const secondDocument = handoff(second.stdout)
  expect(secondDocument.choices[first.id]).toBe('take')
  expect(secondDocument.next?.path).toBe('b')
  expect(await readFile(root)).toEqual(original)
  const unchanged = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(unchanged.status).toBe(1)
  expect(await readFile(root)).toEqual(original)
  const completed = await finishAgentImport(cli, home, archivePath, decisionPath)
  expect(completed.status).toBe(0)
  const merged = JSON.parse(await readFile(root, 'utf8'))
  expect(merged.a).toBe('new a')
  expect(merged.b).toBe('old b')
  expect(merged.$projects.demo.keep).toBe('incoming')
  expect(merged.$projects.other).toEqual({ safe: 'yes' })
  expect(await readFile(join(home, 'payload.txt'), 'utf8')).toBe('incoming payload')
  expect(fs.existsSync(marker)).toBe(false)

  await writeFile(join(home, 'payload.txt'), 'changed after review')
  const stale = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(stale.status).toBe(1)
  expect(stale.stdout).toContain('changed after review')
  expect(await readFile(join(home, 'payload.txt'), 'utf8')).toBe('changed after review')
  expect(JSON.parse(await readFile(root, 'utf8'))).toEqual(merged)
})

test('reviews config takeover and rejects stale import sources before changing source data', async ({
  directory,
  expect,
}) => {
  const ownedHome = join(directory, 'owned-home')
  const ownedFile = join(ownedHome, 'acme/project.json')
  const originalProject = '{"$schemaVersion":2,"agents":"local acme"}\n'
  await config(ownedHome, { $schemaVersion: 2, $projects: { acme: '<root>/acme/project.json' } })
  await put(ownedFile, originalProject)
  const takeover = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      payload: { $type: 'prompt', $exec: '<root>/acme/project.json' },
      $projects: { good: {} },
    }),
    [{ path: 'acme/project.json', data: new TextEncoder().encode('{"$schemaVersion":2,"agents":"takeover"}') }],
  )
  const takeoverPlan = planImport(takeover, { home: ownedHome, cwd: directory })
  const takeoverChoices: Record<string, 'take'> = {}
  let takeoverReview = reviewImport(takeoverPlan, takeoverChoices)
  while (takeoverReview.status === 'incomplete' && takeoverReview.next.kind !== 'file') {
    takeoverChoices[takeoverReview.next.id] = 'take'
    takeoverReview = reviewImport(takeoverPlan, takeoverChoices)
  }
  assert(takeoverReview.status === 'incomplete')
  expect(takeoverReview.next.notice).toContain('configuration for acme')
  expect(await readFile(ownedFile, 'utf8')).toBe(originalProject)

  const staleHome = join(directory, 'stale-import-home')
  const staleRoot = join(staleHome, 'woof.config.json')
  await config(staleHome, { $schemaVersion: 2 })
  const archive = createBundleArchive(rootConfiguration({ $schemaVersion: 2, $projects: { demo: {} } }), [])
  const plan = planImport(archive, { home: staleHome, cwd: directory })
  const review = reviewImport(plan, Object.fromEntries(plan.conflicts.map(item => [item.id, 'take' as const])))
  assert(review.status === 'ready')
  const concurrent = '{"$schemaVersion":2,"localOnly":"preserve concurrent edit"}\n'
  await writeFile(staleRoot, concurrent)
  expect(() => applyImport(review.candidate)).toThrow(/changed after review/)
  expect(await readFile(staleRoot, 'utf8')).toBe(concurrent)
})

test('restores completed resources with original modes when registry replacement fails', async ({
  directory,
  expect,
}) => {
  const home = join(directory, 'rollback-home')
  const root = join(home, 'woof.config.json')
  const payload = join(home, 'payload.txt')
  await config(home, {
    $schemaVersion: 2,
    shared: 'local',
    payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
    $projects: { demo: {} },
  })
  await put(payload, 'local payload')
  await chmod(root, 0o640)
  await chmod(payload, 0o664)
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      shared: 'incoming',
      payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
      added: { $type: 'prompt', $exec: '<root>/nested/new.txt' },
      $projects: { demo: {} },
    }),
    [
      { path: 'payload.txt', data: new TextEncoder().encode('incoming payload') },
      { path: 'nested/new.txt', data: new TextEncoder().encode('new resource') },
    ],
  )
  const candidate = ready(home, archive, directory)
  const originalRename = fs.renameSync
  let failure: unknown
  try {
    fs.renameSync = ((from: string, to: string) => {
      if (to === root) throw new Error('injected registry failure')
      return originalRename(from, to)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    try {
      applyImport(candidate)
    } catch (error) {
      failure = error
    }
  } finally {
    fs.renameSync = originalRename
    syncBuiltinESMExports()
  }
  assert(failure instanceof ImportApplyError)
  expect(failure.report.completed).toEqual(['nested/new.txt', 'payload.txt'])
  expect(failure.report.restored).toEqual(['payload.txt', 'nested/new.txt'])
  expect(failure.report.pending).toEqual(['woof.config.json'])
  expect(JSON.parse(await readFile(root, 'utf8')).shared).toBe('local')
  expect(await readFile(payload, 'utf8')).toBe('local payload')
  expect((await lstat(root)).mode & 0o777).toBe(0o640)
  expect((await lstat(payload)).mode & 0o777).toBe(0o664)
  expect(fs.existsSync(join(home, 'nested'))).toBe(false)
  expect((await readdir(home, { recursive: true })).filter(entry => entry.includes('woof-import-'))).toEqual([])
})

test('backs up the configuration, its files and each replaced file before an import writes', async ({
  directory,
  expect,
}) => {
  const home = join(directory, 'backup-home')
  const original = {
    $schemaVersion: 2,
    payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
    $projects: { demo: '<root>/projects/demo.json' },
  }
  await config(home, original)
  await put(join(home, 'payload.txt'), 'local payload')
  await put(
    join(home, 'projects/demo.json'),
    JSON.stringify({ $schemaVersion: 2, demo: { $type: 'prompt', $exec: '<root>/prompts/demo.md' } }),
  )
  await put(join(home, 'prompts/demo.md'), 'demo')
  await put(join(home, 'stray.txt'), 'local stray')
  await put(join(home, 'notes.txt'), 'unrelated')
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      payload: { $type: 'prompt', $exec: '<root>/payload.txt' },
      stray: { $type: 'prompt', $exec: '<root>/stray.txt' },
      $projects: { other: {} },
    }),
    [
      { path: 'payload.txt', data: strToU8('incoming payload') },
      { path: 'stray.txt', data: strToU8('incoming stray') },
    ],
  )

  const result = applyImport(ready(home, archive, directory))
  assert(result.backup)
  const files = unzipSync(await readFile(result.backup))
  expect(Object.keys(files).sort()).toEqual([
    'payload.txt',
    'projects/demo.json',
    'prompts/demo.md',
    'stray.txt',
    'woof.config.json',
  ])
  expect(strFromU8(files['payload.txt']!)).toBe('local payload')
  expect(strFromU8(files['stray.txt']!)).toBe('local stray')
  expect(JSON.parse(strFromU8(files['woof.config.json']!))).toEqual(original)
  expect(await readFile(join(home, 'payload.txt'), 'utf8')).toBe('incoming payload')
  expect((await lstat(result.backup)).mode & 0o777).toBe(0o600)
})

test('exports referenced checkout files without changing the source or running scripts', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'repo-export-home')
  const checkout = join(directory, 'repo-export-checkout')
  const marker = join(directory, 'repo-export-ran')
  await mkdir(checkout, { recursive: true })
  execFileSync('git', ['init', '-q', checkout])
  // The project's base path is the checkout, so <repo> resolves there.
  const sourceProject = {
    $schemaVersion: 2,
    $metadata: { $basePaths: [checkout] },
    script: { $type: 'node', $exec: '<repo>/scripts/run.js' },
  }
  await config(home, { $schemaVersion: 2, $projects: { demo: '<root>/project.json' } })
  const sourceProjectBytes = Buffer.from(`${JSON.stringify(sourceProject, null, 2)}\r\n`)
  const sourceScriptBytes = Buffer.from(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\r\n`)
  await put(join(home, 'project.json'), sourceProjectBytes.toString())
  await put(join(checkout, 'scripts/run.js'), sourceScriptBytes.toString())
  assert(home.includes('woof-test-'), 'WOOF_HOME must belong to the test fixture')
  const result = await cli.run(process.execPath, [cli.entry, 'export', '--project', 'demo', '--agent'], checkout, {
    WOOF_HOME: home,
  })
  expect(result.status).toBe(0)
  const path = /^Archive: (.+)$/m.exec(result.stdout)?.[1]
  assert(path)
  const bundle = readBundleArchive(await readFile(path))
  expect(bundle.project['script']).toEqual({ $type: 'node', $exec: '<root>/demo-repo-export/scripts/run.js' })
  expect(Buffer.from(bundle.files.get('demo-repo-export/scripts/run.js')!)).toEqual(sourceScriptBytes)
  expect(await readFile(join(home, 'project.json'))).toEqual(sourceProjectBytes)
  expect(fs.existsSync(marker)).toBe(false)
})

test('ignores unrelated archive entries without a fixed entry quota', ({ expect }) => {
  const files: Record<string, Uint8Array> = {
    'woof.config.json': strToU8(JSON.stringify({ $schemaVersion: 2, $projects: { demo: {} } })),
    'CON.txt': strToU8('unrelated'),
    Case: strToU8('one'),
    case: strToU8('two'),
  }
  for (let index = 0; index < 10001; index += 1) files[`extra-${index}`] = new Uint8Array()
  expect([...readBundleArchive(zipSync(files)).files.keys()]).toEqual(['woof.config.json'])
})

test('rejects import renames that turn references into internal markers', async ({ cli, directory, expect }) => {
  for (const project of [false, true]) {
    const home = join(directory, `reserved-name-${project}`)
    await config(home, {
      $schemaVersion: 2,
      ...(project ? {} : { a: 'LOCAL A' }),
      $projects: { demo: project ? { a: 'LOCAL A' } : {} },
    })
    const incoming = { a: 'INCOMING A', b: 'B uses {{a}}' }
    const archive = createBundleArchive(
      rootConfiguration({
        $schemaVersion: 2,
        ...(project ? {} : incoming),
        $projects: { demo: project ? incoming : {} },
      }),
      [],
    )
    const path = join(directory, `reserved-${project}.zip`)
    const decisions = join(directory, `reserved-decisions-${project}.json`)
    await writeFile(path, archive)
    const original = await readFile(join(home, 'woof.config.json'), 'utf8')
    const first = await run(cli, home, ['import', path, '--agent'])
    const document = handoff(first.stdout)
    assert(document.next?.path === 'a')
    const id = document.next.id

    for (const address of ['-x-', '-nested.value-']) {
      document.choices[id] = { action: 'add', address }
      await writeFile(decisions, JSON.stringify(document))
      const rejected = await run(cli, home, ['import', path, '--decisions', decisions, '--agent'])
      expect(rejected.status).toBe(1)
      expect(rejected.stdout).toContain('reserved for internal markers')
      expect(await readFile(join(home, 'woof.config.json'), 'utf8')).toBe(original)
    }

    // Dashes inside a path remain valid when the full reference does not have marker syntax.
    document.choices[id] = { action: 'add', address: 'variants.-x-' }
    await writeFile(decisions, JSON.stringify(document))
    const imported = await reviewAgentImport(cli, home, path, decisions, () => 'take')
    expect(imported.status, imported.stdout).toBe(0)
    const scope = project ? ['--project', 'demo'] : []
    expect(await run(cli, home, ['get', 'b', ...scope, '--agent'])).toMatchObject({
      status: 0,
      stdout: 'B uses INCOMING A',
    })
    expect((await run(cli, home, ['get', 'a', ...scope, '--agent'])).stdout).toBe('LOCAL A')
  }
})

test('remaps imported prompt files and project overrides without changing local references', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'mapping-home')
  await config(home, {
    $schemaVersion: 2,
    agents: 'local {{conventions.commit}}',
    conventions: { commit: 'local' },
    $projects: {},
  })
  await put(join(home, 'prompt.md'), 'local file')
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      agents: 'incoming {{conventions.commit}}',
      conventions: { commit: 'incoming' },
      prompt: '<root>/prompt.md',
      $projects: { demo: { conventions: { commit: 'project' }, agents: 'project {{conventions.commit}}' } },
    }),
    [
      {
        path: 'prompt.md',
        data: Buffer.concat([
          Buffer.from([0xef, 0xbb, 0xbf]),
          strToU8('incoming {{conventions.commit}} {{{{conventions.commit}}}}\r\n'),
        ]),
      },
    ],
  )
  const path = join(directory, 'mapping.zip')
  await writeFile(path, archive)
  let invalidated = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'mapping-decisions.json'), (item, doc) => {
    invalidated ||= Boolean(doc.invalidated?.includes('agents'))
    if (item.kind === 'token' && item.path === 'agents') return 'keep'
    if (item.kind === 'token' && item.path === 'conventions.commit')
      return { action: 'add', address: 'conventions.alternate' }
    if (item.kind === 'file' && item.requiredNewPath) return { action: 'add', address: 'copies/prompt.md' }
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(invalidated).toBe(true)
  expect(await readFile(join(home, 'prompt.md'), 'utf8')).toBe('local file')
  expect(await readFile(join(home, 'copies/prompt.md'))).toEqual(
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      strToU8('incoming {{conventions.alternate}} {{{{conventions.commit}}}}\r\n'),
    ]),
  )
  expect(await run(cli, home, ['get', 'agents', '--agent'])).toMatchObject({ status: 0, stdout: 'local local' })
  expect(await run(cli, home, ['get', 'agents', '--project', 'demo', '--agent'])).toMatchObject({
    status: 0,
    stdout: 'project project',
  })
})

test('keeps reused metadata and reopens reuse after a later mapping changes the content', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'reuse-home')
  await config(home, {
    $schemaVersion: 2,
    matching: { $type: 'prompt', $exec: '{{source}}', $description: 'local metadata' },
    source: 'local',
    $projects: {},
  })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, alias: '{{source}}', source: 'incoming', $projects: { demo: {} } }),
    [],
  )
  const path = join(directory, 'reuse.zip')
  await writeFile(path, archive)
  let rechecked = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'reuse-decisions.json'), (item, doc) => {
    if (item.path === 'alias' && !rechecked) {
      if (doc.invalidated?.includes('alias')) {
        rechecked = true
        return 'take'
      }
      expect(item.candidates).toContain('matching')
      return { action: 'reuse', address: 'matching' }
    }
    if (item.path === 'source') return { action: 'add', address: 'newsource' }
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(rechecked).toBe(true)
  const root = JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8'))
  expect(root.matching.$description).toBe('local metadata')
  expect(root.alias).toBe('{{newsource}}')
})

test('reports post-import validation without undoing an explicit shared-file replacement', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'post-validation-home')
  await config(home, { $schemaVersion: 2, broken: '{{missing}}', $projects: { other: '<root>/other.json' } })
  await put(join(home, 'other.json'), '{"$schemaVersion":2}')
  await fs.promises.symlink('other.json', join(home, 'alias.json'))
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      payload: '<root>/alias.json',
      missingFile: '<root>/missing.md',
      $projects: { demo: {} },
    }),
    [{ path: 'alias.json', data: strToU8('not JSON') }],
  )
  const path = join(directory, 'post-validation.zip')
  await writeFile(path, archive)
  let sawOwnership = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'post-validation-decisions.json'), item => {
    if (item.kind === 'file') {
      sawOwnership ||= Boolean(item.notice?.includes('configuration for other'))
      if (item.notice?.includes('unavailable')) return 'keep'
    }
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(sawOwnership).toBe(true)
  expect((await lstat(join(home, 'alias.json'))).isSymbolicLink()).toBe(true)
  expect(await readFile(join(home, 'other.json'), 'utf8')).toBe('not JSON')
  expect(result.stdout).toContain('Imported demo')
  expect(result.stderr).toContain('other.json')
  expect(result.stderr).toContain('missing')
  expect(result.stderr).toContain('missing.md')
  expect(fs.existsSync(join(home, 'missing.md'))).toBe(false)
  expect(result.stderr).toContain('Repair the configuration files')
})

test('offers a distinct identical file when a prompt reference is remapped', async ({ cli, directory, expect }) => {
  const home = join(directory, 'file-reuse-home')
  await config(home, { $schemaVersion: 2, a: 'local', reusable: '<root>/reuse.md', $projects: {} })
  await put(join(home, 'reuse.md'), 'incoming {{a_variant}}')
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, a: 'incoming', prompt: '<root>/prompt.md', $projects: { demo: {} } }),
    [{ path: 'prompt.md', data: strToU8('incoming {{a}}') }],
  )
  const path = join(directory, 'file-reuse.zip')
  await writeFile(path, archive)
  let offered = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'file-reuse-decisions.json'), item => {
    if (item.kind === 'token' && item.path === 'a') return { action: 'add', address: 'a_variant' }
    if (item.kind === 'file') {
      offered = Boolean(item.requiredNewPath && item.candidates?.includes('reuse.md'))
      return { action: 'reuse', address: 'reuse.md' }
    }
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(offered).toBe(true)
  const root = JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8'))
  expect(root.prompt).toBe('<root>/reuse.md')
  expect(await readFile(join(home, 'reuse.md'), 'utf8')).toBe('incoming {{a_variant}}')
  expect(fs.existsSync(join(home, 'prompt.md'))).toBe(false)
})

test('keeps a reused project override bound to the reused shared token', async ({ cli, directory, expect }) => {
  const home = join(directory, 'bound-reuse-home')
  await config(home, {
    $schemaVersion: 2,
    matchroot: 'A',
    matchproject: 'B',
    $projects: { demo: { matchroot: 'old override' } },
  })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, x: 'A', agents: '{{x}}', $projects: { demo: { x: 'B' } } }),
    [],
  )
  const path = join(directory, 'bound-reuse.zip')
  await writeFile(path, archive)
  let sawBinding = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'bound-reuse-decisions.json'), item => {
    if (item.kind === 'token' && item.path === 'x') return { action: 'reuse', address: 'matchroot' }
    if (item.kind === 'project-token' && item.path === 'x') return { action: 'reuse', address: 'matchproject' }
    if (item.kind === 'project-token' && item.path === 'matchroot') sawBinding = true
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(sawBinding).toBe(true)
  expect(await run(cli, home, ['get', 'agents', '--agent'])).toMatchObject({ status: 0, stdout: 'A' })
  expect(await run(cli, home, ['get', 'agents', '--project', 'demo', '--agent'])).toMatchObject({
    status: 0,
    stdout: 'B',
  })
})

test('reopens a reuse choice when a later file replacement changes its content', async ({ cli, directory, expect }) => {
  const home = join(directory, 'reuse-file-change-home')
  await config(home, { $schemaVersion: 2, matching: '<root>/payload.txt', $projects: { demo: {} } })
  await put(join(home, 'payload.txt'), 'A')
  const archive = createBundleArchive(
    rootConfiguration({
      $schemaVersion: 2,
      alias: 'A',
      use: '{{alias}}',
      other: '<root>/payload.txt',
      $projects: { demo: {} },
    }),
    [{ path: 'payload.txt', data: strToU8('B') }],
  )
  const path = join(directory, 'reuse-file-change.zip')
  await writeFile(path, archive)
  let reopened = false
  const result = await reviewAgentImport(
    cli,
    home,
    path,
    join(directory, 'reuse-file-change-decisions.json'),
    (item, doc) => {
      if (doc.invalidated?.includes('alias')) reopened = true
      if (item.path === 'alias' && !reopened) return { action: 'reuse', address: 'matching' }
      return 'take'
    },
  )
  expect(result.status).toBe(0)
  expect(reopened).toBe(true)
  expect(await readFile(join(home, 'payload.txt'), 'utf8')).toBe('B')
  expect(await run(cli, home, ['get', 'use', '--agent'])).toMatchObject({ status: 0, stdout: 'A' })
})

test('reopens reuse when a project binding would make the reused alias circular', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'reuse-cycle-home')
  await config(home, { $schemaVersion: 2, matchroot: 'A', matchproject: '{{matchroot}}', $projects: { demo: {} } })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, x: 'A', agents: '{{x}}', $projects: { demo: { x: '{{matchroot}}' } } }),
    [],
  )
  const path = join(directory, 'reuse-cycle.zip')
  await writeFile(path, archive)
  let reopened = false
  const result = await reviewAgentImport(
    cli,
    home,
    path,
    join(directory, 'reuse-cycle-decisions.json'),
    (item, doc) => {
      if (doc.invalidated?.includes('x')) reopened = true
      if (item.kind === 'token' && item.path === 'x')
        return reopened ? { action: 'add', address: 'x_variant' } : { action: 'reuse', address: 'matchroot' }
      if (item.kind === 'project-token' && item.path === 'x' && !reopened)
        return { action: 'reuse', address: 'matchproject' }
      return 'take'
    },
  )
  expect(result.status).toBe(0)
  expect(reopened).toBe(true)
  expect(await run(cli, home, ['get', 'agents', '--project', 'demo', '--agent'])).toMatchObject({
    status: 0,
    stdout: 'A',
  })
})

test('reopens project reuse when the conflicting local binding is kept', async ({ cli, directory, expect }) => {
  const home = join(directory, 'kept-binding-home')
  await config(home, {
    $schemaVersion: 2,
    matchroot: 'A',
    matchproject: 'B',
    $projects: { demo: { matchroot: 'old' } },
  })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, x: 'A', agents: '{{x}}', $projects: { demo: { x: 'B' } } }),
    [],
  )
  const path = join(directory, 'kept-binding.zip')
  await writeFile(path, archive)
  let reopened = false
  const result = await reviewAgentImport(
    cli,
    home,
    path,
    join(directory, 'kept-binding-decisions.json'),
    (item, doc) => {
      if (doc.invalidated?.includes('x')) reopened = true
      if (item.kind === 'token' && item.path === 'x') return { action: 'reuse', address: 'matchroot' }
      if (item.kind === 'project-token' && item.path === 'x' && !reopened)
        return { action: 'reuse', address: 'matchproject' }
      if (item.kind === 'project-token' && item.path === 'matchroot' && !reopened) return 'keep'
      return 'take'
    },
  )
  expect(result.status).toBe(0)
  expect(reopened).toBe(true)
  expect(await run(cli, home, ['get', 'agents', '--agent'])).toMatchObject({ status: 0, stdout: 'A' })
  expect(await run(cli, home, ['get', 'agents', '--project', 'demo', '--agent'])).toMatchObject({
    status: 0,
    stdout: 'B',
  })
})

test('reopens reuse when another choice replaces the reused token', async ({ cli, directory, expect }) => {
  const home = join(directory, 'reuse-token-change-home')
  await config(home, { $schemaVersion: 2, matching: 'A', $projects: { demo: {} } })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, alias: 'A', use: '{{alias}}', matching: 'B', $projects: { demo: {} } }),
    [],
  )
  const path = join(directory, 'reuse-token-change.zip')
  await writeFile(path, archive)
  let reopened = false
  const result = await reviewAgentImport(
    cli,
    home,
    path,
    join(directory, 'reuse-token-change-decisions.json'),
    (item, doc) => {
      if (doc.invalidated?.includes('alias')) reopened = true
      if (item.path === 'alias' && !reopened) return { action: 'reuse', address: 'matching' }
      return 'take'
    },
  )
  expect(result.status).toBe(0)
  expect(reopened).toBe(true)
  expect(await run(cli, home, ['get', 'use', '--agent'])).toMatchObject({ status: 0, stdout: 'A' })
  expect(await run(cli, home, ['get', 'matching', '--agent'])).toMatchObject({ status: 0, stdout: 'B' })
})

test('uses a distinct missing destination for an added file-backed token', async ({ cli, directory, expect }) => {
  const home = join(directory, 'missing-add-home')
  await config(home, { $schemaVersion: 2, prompt: 'local', $projects: {} })
  await put(join(home, 'original.md'), 'existing unrelated content')
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, prompt: '<root>/original.md', $projects: { demo: {} } }),
    [],
  )
  const path = join(directory, 'missing-add.zip')
  await writeFile(path, archive)
  let retried = false
  const result = await reviewAgentImport(cli, home, path, join(directory, 'missing-add-decisions.json'), item => {
    if (item.kind === 'token' && item.path === 'prompt') return { action: 'add', address: 'prompt_variant' }
    if (item.kind === 'file') {
      expect(item.requiredNewPath).toBe(true)
      expect(item.notice).toContain('unavailable')
      if (!retried) {
        retried = true
        return { action: 'add', address: 'original.md' }
      }
      return { action: 'add', address: 'missing/new.md' }
    }
    return 'take'
  })
  expect(result.status).toBe(0)
  expect(JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8')).prompt_variant).toBe(
    '<root>/missing/new.md',
  )
  expect(await readFile(join(home, 'original.md'), 'utf8')).toBe('existing unrelated content')
  expect(fs.existsSync(join(home, 'missing/new.md'))).toBe(false)
  expect(result.stderr).toContain('missing/new.md')
})

test('saves a reused project alias when its source cycle already existed', async ({ cli, directory, expect }) => {
  const home = join(directory, 'existing-reuse-cycle-home')
  await config(home, { $schemaVersion: 2, matchroot: 'A', matchproject: '{{matchroot}}', $projects: { demo: {} } })
  const archive = createBundleArchive(
    rootConfiguration({ $schemaVersion: 2, x: 'A', agents: '{{x}}', $projects: { demo: { x: '{{x}}' } } }),
    [],
  )
  const path = join(directory, 'existing-reuse-cycle.zip')
  await writeFile(path, archive)
  const result = await reviewAgentImport(
    cli,
    home,
    path,
    join(directory, 'existing-reuse-cycle-decisions.json'),
    item => {
      if (item.kind === 'token' && item.path === 'x') return { action: 'reuse', address: 'matchroot' }
      if (item.kind === 'project-token' && item.path === 'x') return { action: 'reuse', address: 'matchproject' }
      return 'take'
    },
  )
  expect(result.status).toBe(0)
  expect(result.stdout).toContain('Imported demo')
  expect(result.stderr).toContain('Circular token reference')
  expect(await run(cli, home, ['get', 'agents', '--agent'])).toMatchObject({ status: 0, stdout: 'A' })
  expect((await run(cli, home, ['get', 'agents', '--project', 'demo', '--agent'])).status).toBe(1)
})

test('reopens additions that claim a missing file destination already used by the import', async ({
  directory,
  expect,
}) => {
  for (const [name, order, withBytes, alias] of [
    ['missing-first', ['a', 'b'], true, false],
    ['write-first', ['b', 'a'], true, false],
    ['both-missing', ['a', 'b'], false, false],
    ['parent-alias', ['a', 'b'], true, true],
  ] as const) {
    const home = join(directory, name)
    await config(home, { $schemaVersion: 2, a: 'local A', b: 'local B', $projects: { demo: {} } })
    await mkdir(join(home, 'new'))
    if (alias) await fs.promises.symlink('new', join(home, 'alias'), 'dir')
    const tokens = Object.fromEntries(order.map(key => [key, `<root>/${key}.txt`]))
    const archive = createBundleArchive(
      rootConfiguration({ $schemaVersion: 2, ...tokens, $projects: { demo: {} } }),
      withBytes ? [{ path: 'b.txt', data: Buffer.from('B payload') }] : [],
    )
    const plan = planImport(archive, { home, cwd: directory })
    const choices: Record<string, 'take' | { action: 'add'; address: string }> = {}
    let collision = false
    let ready: Extract<ReturnType<typeof reviewImport>, { status: 'ready' }> | undefined
    for (let count = 0; count < 20; count += 1) {
      const result = reviewImport(plan, choices)
      if (result.status === 'ready') {
        ready = result
        break
      }
      const item = result.next
      if (item.kind === 'token') choices[item.id] = { action: 'add', address: `${item.path}_new` }
      else if (item.kind === 'file') {
        if (item.invalid) collision = true
        choices[item.id] = {
          action: 'add',
          address: collision
            ? `new/${item.path}`
            : alias && item.path === 'b.txt'
              ? 'alias/shared.txt'
              : 'new/shared.txt',
        }
      } else choices[item.id] = 'take'
    }
    expect(collision).toBe(true)
    expect(ready).toBeDefined()
    const resultConfig = ready!.candidate.configuration as Record<string, unknown>
    expect(resultConfig['a_new']).not.toBe(resultConfig['b_new'])
    if (alias) {
      await mkdir(join(home, 'other'))
      await fs.promises.unlink(join(home, 'alias'))
      await fs.promises.symlink('other', join(home, 'alias'), 'dir')
      expect(() => applyImport(ready!.candidate)).toThrow(/changed/)
      await fs.promises.unlink(join(home, 'alias'))
      await fs.promises.symlink('new', join(home, 'alias'), 'dir')
    }
    await applyImport(ready!.candidate)
    const missingPath = String(resultConfig['a_new']).replace('<root>/', '')
    expect(fs.existsSync(join(home, missingPath))).toBe(false)
    if (withBytes)
      expect(await readFile(join(home, String(resultConfig['b_new']).replace('<root>/', '')), 'utf8')).toBe('B payload')
  }
})
