import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

async function config(home: string, value: unknown) {
  await put(join(home, 'woof.config.json'), JSON.stringify(value))
}

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

test('applies project overrides after merging while preserving inherited lookup', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  await config(home, {
    $schemaVersion: 2,
    conventions: { commit: 'base', tests: 'meaningful' },
    agents: '{{conventions.commit}} {{conventions.tests}}',
    $projects: {
      microsoft: { conventions: { commit: 'semantic' } },
      acme: { agents: '{{conventions.commit}} Never touch legacy/.' },
    },
  })

  expect(await run(cli, home, ['get', 'agents', '--project', 'microsoft'])).toMatchObject({
    status: 0,
    stdout: 'semantic meaningful',
  })
  expect(await run(cli, home, ['get', 'conventions.tests', '--project', 'microsoft'])).toMatchObject({
    status: 0,
    stdout: 'meaningful',
  })
  expect(await run(cli, home, ['get', 'agents', '--project', 'acme'])).toMatchObject({
    status: 0,
    stdout: 'base Never touch legacy/.',
  })
  expect(await run(cli, home, ['get', '$projects.microsoft.agents'])).toMatchObject({
    status: 0,
    stdout: 'semantic meaningful',
  })
})

test('rejects global dependencies, self-cycles and missing references before script effects', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const marker = join(cli.project, 'computed-ran')
  await config(home, {
    $schemaVersion: 2,
    globalPrompt: '{{projectOnly}} {{computed}}',
    cyclePrompt: '{{cyclePrompt}}',
    computed: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` },
    $projects: {
      demo: { projectOnly: 'project value', cyclePrompt: '{{cyclePrompt}}' },
    },
  })

  const globalFailure = await run(cli, home, ['get', 'globalPrompt', '--project', 'demo'])
  expect(globalFailure.status).toBe(1)
  expect(globalFailure.stdout).toContain('depends on project-only token')
  expect(existsSync(marker)).toBe(false)

  const cycleFailure = await run(cli, home, ['get', 'cyclePrompt', '--project', 'demo'])
  expect(cycleFailure.status).toBe(1)
  expect(cycleFailure.stdout).toContain('Circular token reference')
  expect(existsSync(marker)).toBe(false)

  const validation = await run(cli, home, ['validate', 'cyclePrompt', '--project', 'demo'])
  expect(validation.status).toBe(1)
  expect(validation.stdout).toContain('Circular token reference')
  expect(existsSync(marker)).toBe(false)
})

test('keeps discovery metadata-only and reuses one literal computed result per resolution', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const counter = join(cli.project, 'counter')
  await config(home, {
    $schemaVersion: 2,
    conventions: { commit: 'literal' },
    computed: {
      $type: 'node',
      $exec: `require('fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n'); process.stdout.write('{{conventions.commit}}')`,
      $description: 'Computed verification',
      $tags: ['verification'],
    },
    twice: '{{computed}} + {{computed}}',
  })

  const discovered = await run(cli, home, ['get', 'computed', '--search'])
  expect(discovered.status).toBe(0)
  expect(discovered.stdout).toContain('Computed verification')
  expect(discovered.stdout).toContain("woof get 'computed'")
  expect(existsSync(counter)).toBe(false)

  const resolved = await run(cli, home, ['get', 'twice'])
  expect(resolved).toMatchObject({ status: 0, stdout: '{{conventions.commit}} + {{conventions.commit}}' })
  expect(await readFile(counter, 'utf8')).toBe('run\n')
})
