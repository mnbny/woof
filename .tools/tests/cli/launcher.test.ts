import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { expect } from 'vitest'

import { put, test } from '../fixtures.ts'

test('the source launcher resolves dependencies from its checkout when called elsewhere', async ({ cli }) => {
  const result = await cli.run(process.execPath, [cli.sourceEntry])

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('woof')
  expect(result.stderr).toBe('')
})

test('the compiled CLI runs outside the checkout without installed dependencies', async ({ cli }) => {
  const result = await cli.run(process.execPath, [cli.entry, '--help'])

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('woof')
  expect(result.stderr).toBe('')
})

test.for(['sourceEntry', 'entry'] as const)(
  'keeps help and early failures plain in agent mode through %s',
  async (entry, { cli }) => {
    const color = { FORCE_COLOR: '1', NO_COLOR: undefined, TERM: 'xterm-256color' }
    for (const args of [['--help'], ['missing-command']]) {
      const [explicit, detected] = await Promise.all([
        cli.run(process.execPath, [cli[entry], ...args, '--agent'], cli.project, color),
        cli.run(process.execPath, [cli[entry], ...args], cli.project, { ...color, CODEX_THREAD_ID: 'present' }),
      ])
      expect(explicit.status).toBe(args.includes('--help') ? 0 : 1)
      expect(detected).toEqual(explicit)
      expect(stripVTControlCharacters(explicit.stdout)).toBe(explicit.stdout)
      expect(stripVTControlCharacters(explicit.stderr)).toBe(explicit.stderr)
      expect(explicit.stdout).not.toBe('')
    }

    const human = await cli.run(process.execPath, [cli[entry], '--help'], cli.project, color)
    expect(human.status).toBe(0)
    expect(stripVTControlCharacters(human.stdout)).not.toBe(human.stdout)
  },
)

test('agent runs recommend the execution skill until a current copy is installed', async ({ cli }) => {
  const run = async () => (await cli.run(process.execPath, [cli.entry, '--help', '--agent'])).stderr
  const installed = join(cli.taskHome, '.agents', 'skills', 'woof-execution', 'SKILL.md')

  expect(await run()).toContain('woof execution skill: not installed')
  await put(installed, '---\nname: woof-execution\n---\n')
  expect(await run()).toContain('woof execution skill: update available')
  await put(installed, await readFile(new URL('../../../skills/woof-execution/SKILL.md', import.meta.url), 'utf8'))
  expect(await run()).toBe('')
})
