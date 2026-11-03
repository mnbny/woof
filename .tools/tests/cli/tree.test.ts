import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { put, test } from '../fixtures.ts'

function tree(output: string) {
  const block = /```text\n([\s\S]*?)\n```/.exec(output)
  if (!block) throw new Error(`No tree in output: ${output}`)
  return block[1]!
}

test('shows configuration structure without reading, resolving or running token content', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const root = join(home, 'woof.config.json')
  const external = join(home, 'projects', 'external.json')
  const effect = join(cli.project, 'script-ran')
  const configuration = {
    $schemaVersion: 2,
    plain: 'BODY MUST NOT APPEAR',
    prompt: {
      $type: 'prompt',
      $exec: 'PRIVATE BODY',
      $description: 'HIDDEN DESCRIPTION',
      $tags: ['HIDDEN TAG'],
      $private: true,
    },
    alias: '{{missing}}',
    cycle: '{{cycle}}',
    file: '<root>/missing-payload.md',
    scripts: {
      bash: { $type: 'bash', $exec: `touch '${effect}'` },
      node: { $type: 'node', $exec: '<root>/missing-script.js' },
      tsx: { $type: 'tsx', $exec: ['invalid code', '<root>/missing-script.ts'] },
      bun: { $type: 'bun', $exec: '{{-woof:private-}}', $private: true },
    },
    empty: {},
    names: { true: 'BOOLEAN-LIKE NAME', null: 'NULL-LIKE NAME', '007': 'NUMERIC NAME' },
    $projects: {
      demo: { $metadata: { $basePaths: [cli.project], $worktreePaths: ['~/work/*'] }, local: 'PROJECT BODY' },
      external: '<root>/projects/external.json',
    },
  }
  await put(root, JSON.stringify(configuration))
  const project = JSON.stringify({ $schemaVersion: 2, nested: { leaf: { $type: 'prompt', $exec: 'EXTERNAL BODY' } } })
  await put(external, project)

  const result = await cli.run(process.execPath, [cli.entry, 'tree', '--agent'], cli.project, { WOOF_HOME: home })
  expect(result.status).toBe(0)
  expect(tree(result.stdout)).toBe(
    [
      '├─ plain: ...',
      '├─ prompt: ...',
      '├─ alias: ...',
      '├─ cycle: ...',
      '├─ file: ...',
      '├─ scripts',
      '│  ├─ bash: ###',
      '│  ├─ node: ###',
      '│  ├─ tsx: ###',
      '│  └─ bun: ###',
      '├─ empty',
      '├─ names',
      '│  ├─ true: ...',
      '│  ├─ null: ...',
      '│  └─ 007: ...',
      '└─ $projects',
      '   ├─ demo',
      '   │  └─ local: ...',
      '   └─ external',
      '      └─ nested',
      '         └─ leaf: ...',
    ].join('\n'),
  )
  expect(result.stdout + result.stderr).not.toMatch(
    /BODY|HIDDEN|missing-payload|missing-script|woof:private|\$metadata|\$basePaths|\$worktreePaths/,
  )
  expect(existsSync(effect)).toBe(false)
  expect(await readFile(root, 'utf8')).toBe(JSON.stringify(configuration))
  expect(await readFile(external, 'utf8')).toBe(project)
})

test('selects exact branches in stored layers without inheriting shared tokens or exposing resource fields', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      git: { commit: 'shared prompt', branch: { naming: 'shared rules' } },
      $projects: {
        demo: { $metadata: { $basePaths: [cli.project] }, git: { commit: { $type: 'bash', $exec: 'exit 99' } } },
        empty: { $metadata: { $basePaths: [] } },
      },
    }),
  )
  const run = (...args: string[]) =>
    cli.run(process.execPath, [cli.entry, 'tree', ...args, '--agent'], cli.project, { WOOF_HOME: home })

  const shared = await run('git')
  expect(shared.status).toBe(0)
  expect(tree(shared.stdout)).toBe('└─ git\n   ├─ commit: ...\n   └─ branch\n      └─ naming: ...')
  const project = await run('--project', 'demo')
  expect(project.status).toBe(0)
  expect(tree(project.stdout)).toBe('└─ $projects\n   └─ demo\n      └─ git\n         └─ commit: ###')
  for (const args of [['git.commit', '--project', 'demo'], ['$projects.demo.git.commit']]) {
    const selected = await run(...args)
    expect(selected.status).toBe(0)
    expect(tree(selected.stdout)).toBe('└─ $projects\n   └─ demo\n      └─ git\n         └─ commit: ###')
  }
  const empty = await run('--project', 'empty')
  expect(empty.status).toBe(0)
  expect(tree(empty.stdout)).toBe('└─ $projects\n   └─ empty')
  for (const path of [
    'git.branch',
    'git.com',
    'git.commit.$exec',
    'git.constructor',
    'git..commit',
    'git.',
    '$metadata',
    '$metadata.$basePaths',
  ]) {
    const missing = await run(path, '--project', 'demo')
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('does not exist in this tree')
    expect(missing.stdout).not.toContain('```text')
  }
  const missing = await run('--project', 'unknown')
  expect(missing.status).toBe(1)
  expect(missing.stdout).toContain('is not registered')
})

test('shows repository definitions only when selected and never substitutes a registered project', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      sharedOnly: 'shared',
      git: { commit: 'shared prompt' },
      $projects: { registered: { $metadata: { $basePaths: [cli.project] }, local: 'registered' } },
    }),
  )
  execFileSync('git', ['init', '-q', cli.project])
  const repository = join(cli.project, '.agents', 'woof.config.json')
  const original = JSON.stringify({ $schemaVersion: 2, git: { commit: { $type: 'node', $exec: '<repo>/absent.js' } } })
  await put(repository, original)
  const run = (args: string[], cwd = cli.project) =>
    cli.run(process.execPath, [cli.entry, 'tree', ...args, '--agent'], cwd, { WOOF_HOME: home })

  const full = await run([])
  expect(full.status).toBe(0)
  expect(tree(full.stdout)).toBe(
    '├─ sharedOnly: ...\n├─ git\n│  └─ commit: ...\n└─ $projects\n   └─ registered\n      └─ local: ...',
  )
  const selected = await run(['--repo'])
  expect(selected.status).toBe(0)
  expect(tree(selected.stdout)).toBe('└─ git\n   └─ commit: ###')
  const branch = await run(['git.commit', '--repo'])
  expect(branch.status).toBe(0)
  expect(tree(branch.stdout)).toBe('└─ git\n   └─ commit: ###')
  const registered = await run(['--project', 'registered'])
  expect(registered.status).toBe(0)
  expect(tree(registered.stdout)).toBe('└─ $projects\n   └─ registered\n      └─ local: ...')
  const absent = await run(['--repo'], directory)
  expect(absent.status).toBe(1)
  expect(absent.stdout).toContain('No repository configuration')
  expect(await readFile(repository, 'utf8')).toBe(original)
})

test('keeps token definition order with registered projects after shared tokens', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'ordered-home')
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      zShared: 'first',
      $projects: {
        zProject: '<root>/z-project.json',
        aProject: { empty: {} },
      },
      aShared: { zRule: 'before', aRule: 'after' },
    }),
  )
  await put(
    join(home, 'z-project.json'),
    JSON.stringify({
      zRule: 'first',
      $schemaVersion: 2,
      $metadata: { $basePaths: [] },
      aRule: 'last',
    }),
  )
  const result = await cli.run(process.execPath, [cli.entry, 'tree', '--agent'], cli.project, { WOOF_HOME: home })
  expect(result.status).toBe(0)
  expect(tree(result.stdout)).toBe(
    [
      '├─ zShared: ...',
      '├─ aShared',
      '│  ├─ zRule: ...',
      '│  └─ aRule: ...',
      '└─ $projects',
      '   ├─ zProject',
      '   │  ├─ zRule: ...',
      '   │  └─ aRule: ...',
      '   └─ aProject',
      '      └─ empty',
    ].join('\n'),
  )
})

test('rejects contradictory tree selectors and extra paths before creating woof home', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'unused-home')
  for (const args of [['--repo', '--project', 'demo'], ['git', 'commit'], ['--shared']]) {
    const result = await cli.run(process.execPath, [cli.entry, 'tree', ...args, '--agent'], cli.project, {
      WOOF_HOME: home,
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('woof could not prepare the invocation')
    expect(existsSync(home)).toBe(false)
  }
})

test('colors tree keys and connectors by depth while keeping markers and agent output plain', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'color-home')
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      git: { branch: { naming: { $type: 'bash', $exec: 'exit 99' } }, commit: 'rules' },
    }),
  )
  // Explicit paths skip all questions, so only stdout needs terminal behavior for this presentation check.
  const terminal = "Object.defineProperty(process.stdout, 'isTTY', { value: true }); await import(process.argv[1])"
  const args = ['--input-type=module', '-e', terminal, cli.entry, 'tree', 'git']
  const env = { WOOF_HOME: home, FORCE_COLOR: '3', NO_COLOR: undefined, TERM: 'xterm-256color' }
  const human = await cli.run(process.execPath, args, cli.project, env)
  expect(human.status).toBe(0)
  // eslint-disable-next-line no-control-regex -- Check that each colored branch resets before its value.
  const matches = [...human.stdout.matchAll(/\u001b\[(38;[^m]+)m[├└]─ (git|commit|branch|naming)\u001b\[([0-9;]+)m/g)]
  const colors = new Map(matches.map(match => [match[2], match[1]]))
  expect(colors.size).toBe(4)
  expect(colors.get('commit')).toBe(colors.get('branch'))
  expect(new Set(colors.values()).size).toBe(3)
  expect(human.stdout).toContain(`\u001b[${colors.get('branch')}m│  `)
  for (const match of matches) expect(match[3]).not.toBe(match[1])
  expect(stripVTControlCharacters(human.stdout)).toContain('commit: ...')
  expect(stripVTControlCharacters(human.stdout)).toContain('naming: ###')

  for (const detected of [false, true]) {
    const agent = await cli.run(process.execPath, [...args, ...(detected ? [] : ['--agent'])], cli.project, {
      ...env,
      ...(detected ? { CODEX_THREAD_ID: 'present' } : {}),
    })
    expect(agent.status).toBe(0)
    expect(stripVTControlCharacters(agent.stdout)).toBe(agent.stdout)
    expect(tree(agent.stdout)).toBe('└─ git\n   ├─ branch\n   │  └─ naming: ###\n   └─ commit: ...')
  }
})
