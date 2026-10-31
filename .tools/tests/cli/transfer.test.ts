import assert from 'node:assert/strict'
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
    choices: Record<string, 'keep' | 'take'>
    next?: { id: string }
    conflicts: { id: string; kind: string; path: string }[]
  }
}

function ready(home: string, archive: Uint8Array, cwd: string) {
  const plan = planImport(archive, { home, cwd })
  const reviewed = reviewImport(plan, Object.fromEntries(plan.conflicts.map(item => [item.id, 'take' as const])))
  assert(reviewed.status === 'ready')
  return reviewed.candidate
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
  const imported = await run(cli, destination, ['import', archivePath, '--agent'])
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
  const [a, b, project, file] = decisions.conflicts
  assert(a && b && project && file)
  expect(decisions.choices).toEqual({})

  decisions.choices[a.id] = 'take'
  await writeFile(decisionPath, JSON.stringify(decisions))
  const second = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(second.status).toBe(1)
  const secondDocument = handoff(second.stdout)
  expect(secondDocument.choices[a.id]).toBe('take')
  expect(secondDocument.choices[b.id]).toBeUndefined()
  expect(secondDocument.next?.id).toBe(b.id)
  expect(await readFile(root)).toEqual(original)

  secondDocument.choices[b.id] = 'keep'
  await writeFile(decisionPath, JSON.stringify(secondDocument))
  const third = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(third.status).toBe(1)
  const thirdDocument = handoff(third.stdout)
  expect(thirdDocument.choices[a.id]).toBe('take')
  expect(thirdDocument.choices[b.id]).toBe('keep')
  expect(thirdDocument.choices[project.id]).toBeUndefined()

  thirdDocument.choices[project.id] = 'take'
  await writeFile(decisionPath, JSON.stringify(thirdDocument))
  const fourth = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(fourth.status).toBe(1)
  const fourthDocument = handoff(fourth.stdout)
  expect(fourthDocument.choices[file.id]).toBeUndefined()
  expect(fourthDocument.next?.id).toBe(file.id)

  const unchanged = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
  expect(unchanged.status).toBe(1)
  expect(await readFile(root)).toEqual(original)
  fourthDocument.choices[file.id] = 'take'
  await writeFile(decisionPath, JSON.stringify(fourthDocument))
  const completed = await run(cli, home, ['import', archivePath, '--decisions', decisionPath, '--agent'])
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
  expect(stale.stdout).toContain('different conflict set')
  expect(await readFile(join(home, 'payload.txt'), 'utf8')).toBe('changed after review')
  expect(JSON.parse(await readFile(root, 'utf8'))).toEqual(merged)
})

test('rejects config takeover and stale import sources before changing source data', async ({ directory, expect }) => {
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
  expect(() => planImport(takeover, { home: ownedHome, cwd: directory })).toThrow(/Raw payload destination/)
  expect(await readFile(ownedFile, 'utf8')).toBe(originalProject)

  const staleHome = join(directory, 'stale-import-home')
  const staleRoot = join(staleHome, 'woof.config.json')
  await config(staleHome, { $schemaVersion: 2 })
  const archive = createBundleArchive(rootConfiguration({ $schemaVersion: 2, $projects: { demo: {} } }), [])
  const plan = planImport(archive, { home: staleHome, cwd: directory })
  const review = reviewImport(plan, {})
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
