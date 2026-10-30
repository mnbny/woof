import { lstat, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { put, test } from '../fixtures.ts'

test.concurrent('creates configuration only on request and quotes editor paths literally', async ({ cli, expect }) => {
  const file = join(cli.taskHome, '.woof', 'woof.config.json')
  expect(await cli.run(process.execPath, [cli.sourceEntry, '--help'])).toMatchObject({ status: 0, stderr: '' })
  await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

  const created = await cli.run(process.execPath, [cli.entry, 'customize'])
  expect(created).toMatchObject({ status: 0, stderr: '', stdout: expect.stringContaining(file) })
  const original = await readFile(file, 'utf8')
  expect(JSON.parse(original)).toEqual({ schemaVersion: 1 })
  expect((await lstat(file)).mode & 0o777).toBe(0o600)
  const command = created.stdout.split('\n').find(line => line.startsWith('code '))
  expect(command).toBeDefined()
  const opened = await cli.run('/bin/sh', ['-c', `code() { printf '%s\\n' "$#:$1"; }\n${command}`])
  expect(opened).toMatchObject({ status: 0, stdout: `1:${file}\n` })

  const shown = await cli.run(process.execPath, [cli.entry, 'customize', '--show'])
  expect(shown).toMatchObject({
    status: 0,
    stdout: expect.stringContaining(JSON.stringify(JSON.parse(original), null, 2)),
  })
  expect(await readFile(file, 'utf8')).toBe(original)
})

test.concurrent(
  'preserves linked settings and uses the selected home without changing the default',
  async ({ cli, directory, expect }) => {
    const selectedHome = join(directory, 'woof state')
    const file = join(selectedHome, 'woof.config.json')
    const target = join(directory, 'personal.json')
    const original = '{ "schemaVersion": 1 }\n'
    const defaultFile = join(cli.taskHome, '.woof', 'woof.config.json')
    await put(defaultFile, 'unrelated configuration\n')
    await put(target, original)
    await put(join(selectedHome, '.gitkeep'), '')
    await symlink(target, file)

    const result = await cli.run(process.execPath, [cli.entry, 'customize', '--agent', '--show'], cli.project, {
      WOOF_HOME: ` ${selectedHome} `,
    })
    expect(result).toMatchObject({ status: 0, stderr: '', stdout: expect.stringContaining(file) })
    expect(result.stdout).toContain(JSON.stringify(JSON.parse(original), null, 2))
    expect((await lstat(file)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe(original)
    expect(await readFile(defaultFile, 'utf8')).toBe('unrelated configuration\n')
  },
)

test.concurrent('keeps explicit and detected agent output plain even when color is forced', async ({ cli, expect }) => {
  const color = { FORCE_COLOR: '1', NO_COLOR: undefined }
  const created = await cli.run(process.execPath, [cli.entry, 'customize', '--agent'], cli.project, color)
  expect(created).toMatchObject({ status: 0, stderr: '' })
  expect(stripVTControlCharacters(created.stdout)).toBe(created.stdout)
  const [explicit, ...detected] = await Promise.all([
    cli.run(process.execPath, [cli.entry, 'customize', '--agent', '--show'], cli.project, color),
    ...['CLAUDECODE', 'CODEX_THREAD_ID', 'AGENT'].map(marker =>
      cli.run(process.execPath, [cli.entry, 'customize', '--show'], cli.project, { ...color, [marker]: 'present' }),
    ),
  ])
  expect(explicit).toMatchObject({ status: 0, stderr: '' })
  for (const result of detected) expect(result).toEqual(explicit)
  expect(stripVTControlCharacters(explicit.stdout)).toBe(explicit.stdout)
  expect(explicit.stdout).toContain('woof customize --agent --show')
  expect(explicit.stdout).toContain('woof customize --agent --help')
})

test.concurrent('rejects unsupported arguments before creating configuration', async ({ cli, expect }) => {
  await Promise.all(
    [['--no-agent'], ['--agent=false'], ['--unknown'], ['--show=false'], ['extra']].map(async args => {
      const result = await cli.run(process.execPath, [cli.entry, 'customize', ...args], cli.project, {
        CLAUDECODE: '1',
        FORCE_COLOR: '1',
        NO_COLOR: undefined,
      })
      expect(result).toMatchObject({ status: 1, stdout: '' })
      expect(result.stderr).not.toBe('')
      expect(stripVTControlCharacters(result.stderr)).toBe(result.stderr)
    }),
  )
  await expect(readFile(join(cli.taskHome, '.woof', 'woof.config.json'), 'utf8')).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test.concurrent.for([
  { source: '{broken', showStatus: 1, guidance: 'woof customize' },
  { source: '{"schemaVersion":2}', showStatus: 0, guidance: 'woof upgrade' },
  { source: '{"schemaVersion":0}', showStatus: 0, guidance: 'woof customize' },
  { source: '{"schemaVersion":1,"unknown":true}', showStatus: 0, guidance: 'woof customize' },
])(
  'keeps invalid settings available for recovery: $source',
  async ({ source, showStatus, guidance }, { cli, expect }) => {
    const file = join(cli.taskHome, '.woof', 'woof.config.json')
    await put(file, source)
    const markers = { CLAUDECODE: '1', FORCE_COLOR: '1', NO_COLOR: undefined }
    const [blocked, location, shown, completion] = await Promise.all([
      cli.run(process.execPath, [cli.entry, '--help'], cli.project, markers),
      cli.run(process.execPath, [cli.entry, 'customize'], cli.project, markers),
      cli.run(process.execPath, [cli.entry, 'customize', '--show'], cli.project, markers),
      cli.run(process.execPath, [cli.entry, 'complete', 'zsh'], cli.project, markers),
    ])
    expect(blocked).toMatchObject({ status: 1, stdout: '', stderr: expect.stringContaining(`${guidance} --agent`) })
    expect(location).toMatchObject({ status: 0, stdout: expect.stringContaining(file) })
    expect(shown.status).toBe(showStatus)
    expect(completion).toMatchObject({ status: 0, stderr: '' })
    for (const result of [blocked, location, shown]) {
      expect(result.stderr).toContain(file)
      expect(stripVTControlCharacters(result.stderr)).toBe(result.stderr)
      expect(stripVTControlCharacters(result.stdout)).toBe(result.stdout)
    }
    expect(await readFile(file, 'utf8')).toBe(source)
  },
)
