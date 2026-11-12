import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'

import manifest from '../../../package.json' with { type: 'json' }
import { put, test } from '../fixtures.ts'

const upgradeTest = test.extend('release', async ({ cli, directory }) => {
  const root = join(directory, 'npm cache', 'node_modules', '@mnbny', 'woof')
  const bin = join(dirname(dirname(root)), '.bin')
  const settings = join(directory, 'registry.json')
  const calls = join(directory, 'npm-calls.jsonl')
  const skill = join(root, 'skills', 'woof-execution', 'SKILL.md')
  const npm = join(cli.bin, 'npm')
  await symlink(process.execPath, join(cli.bin, 'node'))
  await mkdir(bin, { recursive: true })
  await put(settings, JSON.stringify({ version: '9.8.7' }))
  await put(join(root, 'package.json'), JSON.stringify({ name: manifest.name, version: '9.8.7' }))
  await put(skill, '---\nname: woof-execution\nmetadata:\n  version: 999\n---\nReleased skill.\n')
  await put(
    npm,
    `#!${process.execPath}
const { readFileSync, appendFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { delimiter } = require('node:path');
const args = process.argv.slice(2);
const registry = JSON.parse(readFileSync(${JSON.stringify(settings)}, 'utf8'));
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (registry.fail === args[0]) {
  console.error('Registry unavailable');
  process.exit(1);
}
if (args[0] === 'view') {
  process.stdout.write(registry.response ?? JSON.stringify(registry.version));
} else if (args[0] === 'exec') {
  if (!args.includes('--package=' + ${JSON.stringify(manifest.name)} + '@' + registry.version)) {
    throw new Error('The package request must use the resolved version');
  }
  if (!args.includes('--ignore-scripts')) throw new Error('Package scripts must stay disabled');
  const command = args.slice(args.indexOf('--') + 1);
  const result = spawnSync(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, PATH: ${JSON.stringify(bin)} + delimiter + process.env.PATH },
  });
  process.exitCode = result.status ?? 1;
} else {
  throw new Error('Unexpected npm command');
}
`,
  )
  await chmod(npm, 0o755)
  return { root, settings, calls, skill }
})

test('rejects a real npm metadata-cache fallback after the registry becomes unavailable', async ({
  cli,
  directory,
  expect,
}) => {
  const npmCli = await realpath(join(dirname(process.execPath), 'npm'))
  const wrapper = join(cli.bin, 'npm')
  const calls = join(directory, 'npm-commands.txt')
  await put(
    wrapper,
    `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, process.argv[2] + '\\n');\nrequire(${JSON.stringify(npmCli)});\n`,
  )
  await chmod(wrapper, 0o755)
  await symlink(process.execPath, join(cli.bin, 'node'))
  let available = true
  let requests = 0
  const server = createServer((_request, response) => {
    requests++
    if (!available) {
      response.writeHead(503).end('Registry unavailable')
      return
    }
    response.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=300, stale-if-error=604800',
    })
    response.end(
      JSON.stringify({
        name: manifest.name,
        'dist-tags': { latest: '9.8.7' },
        versions: { '9.8.7': { name: manifest.name, version: '9.8.7' } },
      }),
    )
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The registry has no TCP port.')
    const markers = {
      WOOF_HOME: join(directory, 'uninitialized'),
      TMPDIR: directory,
      npm_config_cache: join(directory, 'npm-cache'),
      npm_config_registry: `http://127.0.0.1:${address.port}/`,
      npm_config_fetch_retries: '0',
    }
    const view = [npmCli, 'view', `${manifest.name}@latest`, 'version', '--json', '--prefer-online']
    expect((await cli.run(process.execPath, view, cli.project, markers)).status).toBe(0)
    available = false
    expect(await cli.run(process.execPath, view, cli.project, markers)).toMatchObject({
      status: 0,
      stdout: '"9.8.7"\n',
    })
    for (const setting of ['npm_config_prefer_offline', 'npm_config_offline']) {
      const before = requests
      const result = await cli.run(process.execPath, [cli.entry, 'upgrade', '--agent'], cli.project, {
        ...markers,
        [setting]: 'true',
      })
      expect(requests).toBeGreaterThan(before)
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('woof could not check the latest release')
      expect(result.stdout).not.toContain('Latest release:')
      expect(result.stderr).toBe('')
      expect((await readFile(calls, 'utf8')).trim().split('\n')).not.toContain('exec')
    }
    expect(existsSync(markers.WOOF_HOME)).toBe(false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
})

upgradeTest(
  'uses the exact released skill and pin without loading or changing catalogs and installed skills',
  async ({ cli, directory, release, expect }) => {
    const home = join(directory, 'woof home')
    const config = join(home, 'woof.config.json')
    const projectConfig = join(cli.project, 'woof.config.json')
    const installed = join(cli.taskHome, '.agents/skills/woof-execution/SKILL.md')
    const oldSkill = '---\nname: woof-execution\nmetadata:\n  version: 1\n---\nLocal skill.\n'
    await put(config, 'invalid configuration')
    await put(projectConfig, 'invalid repository configuration')
    await put(installed, oldSkill)

    for (const entry of [cli.entry, cli.sourceEntry]) {
      const result = await cli.run(process.execPath, [entry, 'upgrade', '--agent'], cli.project, { WOOF_HOME: home })
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(`Running version: ${manifest.version}`)
      expect(result.stdout).toContain('Latest release: 9.8.7')
      expect(result.stdout).toContain('Latest woof-execution skill: 999')
      expect(result.stdout).toContain('npx --yes @mnbny/woof@9.8.7 <command> --agent')
      expect(result.stdout).toContain(dirname(release.skill))
      expect(result.stdout).toContain(`${dirname(installed)} (version 1)`)
      expect(result.stdout).toContain('Stop using earlier version pins')
    }
    const human = await cli.run(process.execPath, [cli.entry, 'upgrade'], cli.project, { WOOF_HOME: home })
    expect(human.status).toBe(0)
    expect(human.stdout).toContain('npx --yes @mnbny/woof@9.8.7')
    expect(human.stdout).toContain('999')
    expect(human.stdout).not.toContain(dirname(release.skill))
    expect(human.stdout).not.toContain('Stop using earlier version pins')
    expect(await readFile(config, 'utf8')).toBe('invalid configuration')
    expect(await readFile(projectConfig, 'utf8')).toBe('invalid repository configuration')
    expect(await readFile(installed, 'utf8')).toBe(oldSkill)
  },
)

upgradeTest(
  'checks skill freshness even when the running package matches latest and leaves a fresh home untouched',
  async ({ cli, directory, release, expect }) => {
    const home = join(directory, 'uninitialized')
    await put(release.settings, JSON.stringify({ version: manifest.version }))
    await put(join(release.root, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version }))
    const run = () => cli.run(process.execPath, [cli.entry, 'upgrade', '--agent'], cli.project, { WOOF_HOME: home })
    const missing = await run()
    expect(missing.status).toBe(0)
    expect(missing.stdout).toContain('Installed skill copies:\nnone')
    expect(missing.stderr).toBe('')

    const installed = join(cli.taskHome, '.agents/skills/woof-execution/SKILL.md')
    await put(installed, '---\nname: woof-execution\nmetadata:\n  version: 1\n---\n')
    const result = await run()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`Latest release: ${manifest.version}`)
    expect(result.stdout).toContain('older than version 999')
    expect(result.stdout).toContain(`${dirname(installed)} (version 1)`)
    expect(result.stderr).toBe('')
    expect(existsSync(home)).toBe(false)
    expect(existsSync(join(cli.taskHome, '.claude'))).toBe(false)
  },
)

upgradeTest(
  'reports registry and released-skill failures without offering an old upgrade source',
  async ({ cli, directory, release, expect }) => {
    const home = join(directory, 'uninitialized')
    const run = () => cli.run(process.execPath, [cli.entry, 'upgrade', '--agent'], cli.project, { WOOF_HOME: home })
    for (const settings of [
      { version: '9.8.7', fail: 'view' },
      { version: '9.8.7', fail: 'exec' },
      { response: 'not json' },
      { response: JSON.stringify('9.8.7; unexpected command') },
    ]) {
      await put(release.settings, JSON.stringify(settings))
      const result = await run()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('woof could not check the latest release')
      expect(result.stdout).not.toContain('Stop using earlier version pins')
      expect(result.stderr).toBe('')
    }
    await put(release.settings, JSON.stringify({ version: '9.8.7' }))
    await rm(release.skill)
    const missing = await run()
    expect(missing.status).toBe(1)
    expect(missing.stdout).toContain('no readable execution skill version')
    expect(missing.stderr).toBe('')
    expect(existsSync(home)).toBe(false)
  },
)

upgradeTest(
  'keeps upgrade help passive and rejects migration and positional input before npm or startup',
  async ({ cli, directory, release, expect }) => {
    const home = join(directory, 'uninitialized')
    for (const args of [['--help'], ['--migrate'], ['unexpected'], ['--project', 'example']]) {
      const result = await cli.run(process.execPath, [cli.entry, 'upgrade', ...args, '--agent'], cli.project, {
        WOOF_HOME: home,
      })
      expect(result.status).toBe(args[0] === '--help' ? 0 : 1)
      expect(result.stderr).toBe('')
    }
    expect(existsSync(release.calls)).toBe(false)
    expect(existsSync(home)).toBe(false)
  },
)
