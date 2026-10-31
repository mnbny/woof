import { strToU8, zipSync } from 'fflate'
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
    computed: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` },
    $projects: {
      demo: { conventions: { commit: 'project override' } },
      other: { agents: 'other project', missing: '{{not-selected}}' },
    },
  })
  await mkdir(join(source, 'shared'), { recursive: true })
  await writeFile(join(source, 'shared/commit.md'), raw)
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
  expect(Buffer.from(bundle.files.get('shared/commit.md')!)).toEqual(raw)
  expect(await readFile(join(source, 'woof.config.json'))).toEqual(original)
  expect(fs.existsSync(marker)).toBe(false)

  await config(destination, { $schemaVersion: 2, $projects: { local: { agents: 'local project' } } })
  const imported = await finishAgentImport(cli, destination, archivePath, join(directory, 'roundtrip-decisions.json'))
  expect(imported.status).toBe(0)
  expect(await readFile(join(destination, 'shared/commit.md'))).toEqual(raw)
  expect(await run(cli, destination, ['get', 'agents', '--project', 'demo'])).toMatchObject({
    status: 0,
    stdout: 'project override',
  })
  expect(await run(cli, destination, ['get', 'conventions.commit'])).toMatchObject({
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
  const sourceProject = { $schemaVersion: 2, script: { $type: 'node', $exec: '<repo>/scripts/run.js' } }
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
