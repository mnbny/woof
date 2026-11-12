import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

test('forwards quoted arguments through scripts, lists, aliases and compositions without shell expansion', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const inline = 'process.stdout.write(JSON.stringify(process.argv.slice(1)) + "\\n")'
  const bash = 'printf "%s\\0" "$@"'
  await put(join(home, 'script.js'), 'process.stdout.write(JSON.stringify(process.argv.slice(2)) + "\\n")')
  await put(join(home, 'script.sh'), bash)
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      node: { $type: 'node', $exec: [inline, '<root>/script.js'], $arguments: [{ name: 'platform' }] },
      bash: { $type: 'bash', $exec: [bash, '<root>/script.sh'] },
      alias: '{{node}}',
      composed: '{{alias}}{{node}}',
      prompt: 'Leave {{@platform:ios@}} as text.',
    }),
  )
  const args = String.raw`--variant "woof alt" ios --flag=value "" 'single value' escaped\ space '$HOME' '$(printf surprise)' "it's fine" "a\q"`
  const expected = [
    '--variant',
    'woof alt',
    'ios',
    '--flag=value',
    '',
    'single value',
    'escaped space',
    '$HOME',
    '$(printf surprise)',
    "it's fine",
    'a\\q',
  ]
  const run = (path: string, value = args) =>
    cli.run(process.execPath, [cli.entry, 'get', path, '--args', value, '--agent'], cli.project, { WOOF_HOME: home })
  expect(await run('node')).toMatchObject({ status: 0, stdout: `${JSON.stringify(expected)}\n`.repeat(2) })
  expect(await run('bash')).toMatchObject({ status: 0, stdout: `${expected.join('\0')}\0`.repeat(2) })
  expect(await run('composed')).toMatchObject({ status: 0, stdout: `${JSON.stringify(expected)}\n`.repeat(4) })
  expect(await run('node', '')).toMatchObject({ status: 0, stdout: '[]\n[]\n' })
  expect(await run('prompt', '"unfinished')).toMatchObject({ status: 0, stdout: 'Leave {{@platform:ios@}} as text.' })
})

test('keeps script flags out of startup parsing and rejects broken quoting before script effects', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const effect = join(directory, 'ran')
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      script: { $type: 'node', $exec: 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' },
      effect: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran')` },
    }),
  )
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  for (const value of ['--help', '--version', '--migrate', '--agent', '--', '--variant=debug', '-v']) {
    expect(await run(['get', 'script', '--args', value])).toMatchObject({ status: 0, stdout: JSON.stringify([value]) })
  }
  expect(await run(['get', '--args=--help', 'script'])).toMatchObject({ status: 0, stdout: '["--help"]' })
  expect(
    await cli.run(process.execPath, [cli.entry, 'get', 'script', '--args', '--agent'], cli.project, {
      WOOF_HOME: home,
    }),
  ).toMatchObject({
    status: 0,
    stdout: '["--agent"]',
    stderr: '',
  })
  for (const value of ['"unfinished', 'unfinished\\']) {
    expect((await run(['get', 'effect', '--args', value])).status).toBe(1)
    expect(existsSync(effect)).toBe(false)
  }
})

test('keeps argument descriptions discoverable and preserves them across edits and overrides', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const file = join(home, 'woof.config.json')
  const declarations = [
    { name: 'platform', description: 'Platform to build' },
    { name: '--variant', description: 'App variant' },
  ]
  await put(file, JSON.stringify({ $schemaVersion: 2, alias: '{{build}}', $projects: { demo: {} } }))
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  expect(
    (
      await run([
        'add',
        'build',
        '--type',
        'node',
        '--shared',
        '--content',
        'process.stdout.write("ran")',
        '--arguments',
        JSON.stringify(declarations),
      ])
    ).status,
  ).toBe(0)
  const search = await run(['get', '--search', '--args', '--variant "woof alt"'])
  expect(search.status).toBe(0)
  expect(search.stdout).toMatch(/alias[^\n]*\[has arguments\]/)
  expect(search.stdout).toMatch(/build[^\n]*\[has arguments\]/)
  expect(search.stdout).not.toContain('Platform to build')
  expect(search.stdout).toContain(`--args '--variant "woof alt"'`)
  expect(search.stdout).toContain("woof explain 'PATH'")
  const explanation = await run(['explain', 'alias'])
  expect(explanation.status).toBe(0)
  expect(explanation.stdout).toContain('Arguments: platform: Platform to build, --variant: App variant')
  expect((await run(['validate', 'build'])).status).toBe(0)
  expect(await run(['get', 'build'])).toMatchObject({ status: 0, stdout: 'ran' })
  expect((await run(['edit', 'build'])).stdout).toContain('Arguments: platform: Platform to build')
  expect((await run(['edit', 'build', '--description', 'Build the app'])).status).toBe(0)
  expect(
    (await run(['edit', 'build', '--project', 'demo', '--override', '--description', 'Project build'])).status,
  ).toBe(0)
  let saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.build.$arguments).toEqual(declarations)
  expect(saved.$projects.demo.build.$arguments).toEqual(declarations)
  const replacement = [{ name: '--variant' }]
  expect((await run(['edit', 'build', '--project', 'demo', '--arguments', JSON.stringify(replacement)])).status).toBe(0)
  saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.$projects.demo.build.$arguments).toEqual(replacement)
  expect((await run(['edit', 'build', '--project', 'demo', '--arguments', '[]'])).status).toBe(0)
  saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved.$projects.demo.build.$arguments).toBeUndefined()
  expect(saved.build.$arguments).toEqual(declarations)
  for (const bad of ['{}', '[{"name":42}]', '[{"name":"platform","required":true}]']) {
    expect((await run(['edit', 'build', '--shared', '--arguments', bad])).status).toBe(1)
    expect(JSON.parse(await readFile(file, 'utf8')).build.$arguments).toEqual(declarations)
  }
  expect(
    (
      await run([
        'add',
        'prompt',
        '--shared',
        '--type',
        'prompt',
        '--content',
        'text',
        '--arguments',
        JSON.stringify(declarations),
      ])
    ).status,
  ).toBe(1)
  expect(JSON.parse(await readFile(file, 'utf8')).prompt).toBeUndefined()
})
