import { chmod, readFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'

import { put, test as baseTest } from '../fixtures.ts'

const test = baseTest.extend('upgrade', async ({ cli, directory }) => {
  const checkout = cli.checkout
  const remote = join(directory, 'remote.git')
  const publisher = join(directory, 'publisher')

  async function git(args: string[], cwd = checkout) {
    const result = await cli.run(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', ...args],
      cwd,
    )
    if (result.status) throw new Error(result.stderr)
    return result.stdout.trimEnd()
  }

  await put(join(checkout, '.gitignore'), 'node_modules\n')
  await put(join(checkout, 'local.txt'), 'initial\n')
  await put(join(checkout, 'partial.txt'), 'first\nsecond\nthird\n')
  await git(['init', '--quiet', '-b', 'master'])
  await git(['add', '.'])
  await git(['commit', '--quiet', '-m', 'Initial'])
  await git(['clone', '--quiet', '--bare', checkout, remote])
  await git(['remote', 'add', 'origin', remote])
  await git(['fetch', '--quiet', 'origin'])
  await git(['branch', '--set-upstream-to=origin/master'])
  await git(['clone', '--quiet', remote, publisher])

  async function publish(file = 'upstream.txt', content = 'new upstream content\n') {
    await put(join(publisher, file), content)
    await git(['add', file], publisher)
    await git(['commit', '--quiet', '-m', 'Upstream change'], publisher)
    await git(['push', '--quiet'], publisher)
    return git(['rev-parse', 'HEAD'], publisher)
  }

  function run(args: string[] = ['--agent'], markers: NodeJS.ProcessEnv = {}) {
    return cli.run(process.execPath, [cli.checkoutEntry, 'upgrade', ...args], cli.project, markers)
  }

  return { checkout, git, publish, run }
})

test.concurrent(
  'upgrades the source checkout, detects agents, and bypasses invalid configuration',
  async ({ cli, upgrade, expect }) => {
    const config = join(cli.taskHome, '.woof', 'woof.config.json')
    await put(config, 'invalid')
    await put(join(cli.project, 'caller-work.txt'), 'unrelated local work')
    const head = await upgrade.publish()
    const result = await upgrade.run([], { CLAUDECODE: '1', FORCE_COLOR: '1', NO_COLOR: undefined })
    expect(result).toMatchObject({ status: 0, stderr: expect.stringContaining(config) })
    expect(result.stdout).toContain(`Checkout: ${upgrade.checkout}`)
    expect(result.stdout).toContain('Branch: master')
    expect(result.stdout).toContain(`to ${head}`)
    expect(stripVTControlCharacters(result.stdout)).toBe(result.stdout)
    expect(stripVTControlCharacters(result.stderr)).toBe(result.stderr)
    expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(await readFile(join(cli.project, 'caller-work.txt'), 'utf8')).toBe('unrelated local work')
    const again = await upgrade.run()
    expect(again).toMatchObject({ status: 0, stderr: result.stderr })
    expect(again.stdout).toContain('Already current.')
    expect(await readFile(config, 'utf8')).toBe('invalid')
  },
)

test.concurrent(
  'refuses all local change types and provides agent permission guidance without writes',
  async ({ upgrade, expect }) => {
    await put(join(upgrade.checkout, 'local.txt'), 'staged\n')
    await upgrade.git(['add', 'local.txt'])
    await put(join(upgrade.checkout, 'partial.txt'), 'unstaged\n')
    await put(join(upgrade.checkout, 'new.txt'), 'untracked\n')
    const status = await upgrade.git(['status', '--porcelain'])
    const head = await upgrade.git(['rev-parse', 'HEAD'])
    await upgrade.publish()
    const result = await upgrade.run()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Ask the user whether to stash')
    expect(result.stdout).toContain('Reuse explicit permission')
    expect(result.stdout).toContain('woof upgrade --agent --stash')
    expect(result.stdout).toMatch(/## Next action[\s\S]*## Errors/)
    for (const name of ['local.txt', 'partial.txt', 'new.txt']) expect(result.stdout).toContain(name)
    expect(await upgrade.git(['status', '--porcelain'])).toBe(status)
    expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(await upgrade.git(['stash', 'list'])).toBe('')

    const human = await upgrade.run([])
    expect(human.status).toBe(1)
    expect(human.stdout).toContain('Local changes:')
    expect(human.stdout).toContain('woof upgrade --stash')
    expect(human.stdout.trim().endsWith('Local changes block the upgrade. Nothing was changed.')).toBe(true)
    for (const text of ['Pull: Not attempted', 'No stash created', 'Dependencies:', 'Upgrade needs attention'])
      expect(human.stdout).not.toContain(text)
  },
)

test.concurrent.for([false, true])(
  'skips dirty-checkout handling when upstream has no incoming commits (locally ahead: %s)',
  { timeout: 10_000 },
  async (ahead, { upgrade, expect }) => {
    if (ahead) await upgrade.git(['commit', '--quiet', '--allow-empty', '-m', 'Local commit'])
    await put(join(upgrade.checkout, 'local.txt'), 'older work\n')
    await upgrade.git(['stash', 'push', '-m', 'unrelated'])
    await put(join(upgrade.checkout, 'partial.txt'), 'staged first\nsecond\nthird\n')
    await upgrade.git(['add', 'partial.txt'])
    await put(join(upgrade.checkout, 'partial.txt'), 'staged first\nsecond\nunstaged third\n')
    await put(join(upgrade.checkout, 'new.txt'), 'untracked\n')
    const before = await Promise.all([
      upgrade.git(['rev-parse', 'HEAD']),
      upgrade.git(['diff', '--cached']),
      upgrade.git(['diff']),
      upgrade.git(['status', '--porcelain']),
      upgrade.git(['reflog', 'show', '--format=%H %gs', 'refs/stash']),
    ])

    for (const args of [[], ['--stash'], ['--agent'], ['--agent', '--stash']]) {
      const result = await upgrade.run(args)
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Already current.')
      for (const text of [
        'Local changes block',
        'Ask the user',
        'Recovery stash:',
        'Stashing local changes',
        'Pulling checkout',
      ])
        expect(result.stdout).not.toContain(text)
    }

    expect(
      await Promise.all([
        upgrade.git(['rev-parse', 'HEAD']),
        upgrade.git(['diff', '--cached']),
        upgrade.git(['diff']),
        upgrade.git(['status', '--porcelain']),
        upgrade.git(['reflog', 'show', '--format=%H %gs', 'refs/stash']),
      ]),
    ).toEqual(before)
    expect(await readFile(join(upgrade.checkout, 'new.txt'), 'utf8')).toBe('untracked\n')
  },
)

test.concurrent(
  'reports a failed upstream check without stashing or claiming the checkout is current',
  async ({ directory, upgrade, expect }) => {
    await put(join(upgrade.checkout, 'local.txt'), 'local work\n')
    await upgrade.git(['remote', 'set-url', 'origin', join(directory, 'missing-remote.git')])
    const result = await upgrade.run(['--agent', '--stash'])
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('Already current.')
    expect(result.stdout).not.toContain('Recovery stash:')
    expect(result.stdout).toContain('missing-remote.git')
    expect(await upgrade.git(['stash', 'list'])).toBe('')
    expect(await readFile(join(upgrade.checkout, 'local.txt'), 'utf8')).toBe('local work\n')
  },
)

test.concurrent.for([true, false])(
  'restores partial staging and untracked files while preserving an older stash',
  async (agent, { upgrade, expect }) => {
    await put(join(upgrade.checkout, 'local.txt'), 'older stash\n')
    await upgrade.git(['stash', 'push', '-m', 'unrelated'])
    const older = await upgrade.git(['stash', 'list', '--format=%H %gs'])
    await put(join(upgrade.checkout, 'partial.txt'), 'staged first\nsecond\nthird\n')
    await upgrade.git(['add', 'partial.txt'])
    await put(join(upgrade.checkout, 'partial.txt'), 'staged first\nsecond\nunstaged third\n')
    await put(join(upgrade.checkout, 'new.txt'), 'untracked content\n')
    const staged = await upgrade.git(['diff', '--cached'])
    const unstaged = await upgrade.git(['diff'])
    await upgrade.publish()
    const result = await upgrade.run(agent ? ['--agent', '--stash'] : ['--stash'])
    expect(result).toMatchObject({ status: 0, stderr: '' })
    expect(result.stdout).toContain('Local changes and staged state restored.')
    expect(await upgrade.git(['diff', '--cached'])).toBe(staged)
    expect(await upgrade.git(['diff'])).toBe(unstaged)
    expect(await readFile(join(upgrade.checkout, 'new.txt'), 'utf8')).toBe('untracked content\n')
    expect(await upgrade.git(['stash', 'list', '--format=%H %gs'])).toBe(older)
    if (!agent) {
      expect(result.stdout.match(/Upgraded from/g)).toHaveLength(1)
      expect(result.stdout.match(/Local changes and staged state restored\./g)).toHaveLength(1)
      expect(result.stdout).toMatch(/Local changes stashed\.[\s\S]*Upgraded from/)
      expect(result.stdout.trim().endsWith('Local changes and staged state restored.')).toBe(true)
    }
  },
)

test.concurrent.for([true, false])(
  'restores its stash after a divergent pull fails despite autostash and rebase config',
  async (agent, { upgrade, expect }) => {
    await upgrade.git(['config', 'pull.rebase', 'true'])
    await upgrade.git(['config', 'rebase.autoStash', 'true'])
    await upgrade.git(['config', 'merge.autoStash', 'true'])
    await put(join(upgrade.checkout, 'committed.txt'), 'local commit\n')
    await upgrade.git(['add', 'committed.txt'])
    await upgrade.git(['commit', '--quiet', '-m', 'Local commit'])
    const head = await upgrade.git(['rev-parse', 'HEAD'])
    await put(join(upgrade.checkout, 'local.txt'), 'staged local work\n')
    await upgrade.git(['add', 'local.txt'])
    const staged = await upgrade.git(['diff', '--cached'])
    await upgrade.publish()
    const result = await upgrade.run(agent ? ['--agent', '--stash'] : ['--stash'])
    expect(result.status).toBe(1)
    if (agent) expect(result.stdout).toContain('Pull: Failed.')
    else {
      expect(result.stdout).not.toContain('Upgraded from')
      expect(result.stdout).not.toContain('Pulling checkout Failed.')
      expect(result.stdout).toMatch(/Local changes and staged state restored\.[\s\S]*Could not pull the checkout\./)
    }
    expect(result.stdout).toContain('Local changes and staged state restored.')
    expect(await upgrade.git(['diff', '--cached'])).toBe(staged)
    expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(head)
    expect(await upgrade.git(['stash', 'list'])).toBe('')
  },
)

test.concurrent.for([true, false])(
  'reports stash restoration failure and retains changes in agent mode %s',
  async (agent, { upgrade, expect }) => {
    await put(join(upgrade.checkout, 'local.txt'), 'local work\n')
    const head = await upgrade.publish('local.txt', 'upstream work\n')
    const result = await upgrade.run(agent ? ['--agent', '--stash'] : ['--stash'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Could not restore local changes.')
    expect(result.stdout).toContain('Recovery stash retained:')
    expect(result.stdout).toContain('Do not apply the stash again over partially restored changes.')
    expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(head)
    const stash = await upgrade.git(['stash', 'list', '--format=%H'])
    expect(stash).toMatch(/^[a-f0-9]{40}$/)
    expect(await upgrade.git(['show', `${stash}:local.txt`])).toBe('local work')
    expect(result.stdout).toContain(stash)
    if (agent) expect(result.stdout).toMatch(/## Next action[\s\S]*## Errors/)
    if (!agent) {
      expect(result.stdout.trim().endsWith(`Could not restore local changes. Recovery stash retained: ${stash}.`)).toBe(
        true,
      )
      expect(result.stdout).not.toContain('Upgrade needs attention')
      expect(result.stdout).not.toContain('Command failed:')
      expect(result.stdout).not.toContain('Restoring local changes Failed.')
      expect(result.stdout).not.toContain('Local changes and staged state restored.')
      expect(result.stdout.match(/Upgraded from/g)).toHaveLength(1)
      expect(result.stdout).toMatch(/Upgraded from[\s\S]*Inspect git status[\s\S]*Could not restore local changes\./)
    }
  },
)

test.concurrent(
  'updates the running worktree without changing its sibling checkout',
  async ({ cli, directory, upgrade, expect }) => {
    const worktree = join(directory, 'linked-worktree')
    await upgrade.git(['worktree', 'add', '--quiet', '-b', 'development', worktree])
    await upgrade.git(['branch', '--set-upstream-to=origin/master', 'development'])
    await symlink(join(upgrade.checkout, 'node_modules'), join(worktree, 'node_modules'))
    const original = await upgrade.git(['rev-parse', 'HEAD'])
    const head = await upgrade.publish()
    const result = await cli.run(process.execPath, [join(worktree, 'cli', 'woof.mjs'), 'upgrade', '--agent'])
    expect(result).toMatchObject({ status: 0, stderr: '' })
    expect(result.stdout).toContain(`Checkout: ${worktree}`)
    expect(result.stdout).toContain('Branch: development')
    expect(await upgrade.git(['rev-parse', 'HEAD'], worktree)).toBe(head)
    expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(original)
  },
)

test.concurrent.for([
  { exit: 0, agent: true },
  { exit: 1, agent: true },
  { exit: 0, agent: false },
  { exit: 1, agent: false },
])(
  'installs changed source dependencies and reports installer exit %s',
  async ({ exit, agent }, { cli, upgrade, expect }) => {
    const pnpm = join(cli.bin, 'pnpm')
    await put(pnpm, `#!/bin/sh\nprintf '%s\\n' "$PWD" "$@" > install-result.txt\nexit ${exit}\n`)
    await chmod(pnpm, 0o755)
    const pkg = JSON.parse(await readFile(join(upgrade.checkout, 'package.json'), 'utf8')) as Record<string, unknown>
    pkg['description'] = 'Updated checkout'
    await upgrade.publish('package.json', JSON.stringify(pkg))
    const result = await cli.run(process.execPath, [cli.sourceEntry, 'upgrade', ...(agent ? ['--agent'] : [])])
    expect(result.status).toBe(exit)
    expect(await readFile(join(upgrade.checkout, 'install-result.txt'), 'utf8')).toBe(
      `${upgrade.checkout}\ninstall\n--frozen-lockfile\n`,
    )
    if (agent)
      expect(result.stdout).toContain(
        exit ? 'Dependencies: Installation failed.' : 'Dependencies: Installed from the checkout lockfile.',
      )
    else {
      const final = exit ? 'Could not install source dependencies.' : 'Source dependencies installed.'
      expect(result.stdout).toContain(final)
      expect(result.stdout.indexOf('Upgraded from')).toBeLessThan(result.stdout.indexOf(final))
      expect(result.stdout.match(/Upgraded from/g)).toHaveLength(1)
      if (exit) expect(result.stdout).not.toContain('Source dependencies installed.')
      else expect(result.stdout.trim().endsWith(final)).toBe(true)
    }
    if (exit) expect(result.stdout).toContain('Run pnpm install --frozen-lockfile')
  },
)

test.concurrent('refuses detached HEAD and missing upstream before stashing', async ({ upgrade, expect }) => {
  await upgrade.git(['checkout', '--quiet', '--detach'])
  await put(join(upgrade.checkout, 'local.txt'), 'work\n')
  const detached = await upgrade.run(['--agent', '--stash'])
  expect(detached.status).toBe(1)
  expect(detached.stdout).toContain('Detached HEAD')
  await upgrade.git(['checkout', '--quiet', 'master'])
  await upgrade.git(['branch', '--unset-upstream'])
  const untracked = await upgrade.run(['--agent', '--stash'])
  expect(untracked.status).toBe(1)
  expect(untracked.stdout).toContain('no upstream')
  expect(await readFile(join(upgrade.checkout, 'local.txt'), 'utf8')).toBe('work\n')
  expect(await upgrade.git(['stash', 'list'])).toBe('')
})

test.concurrent('rejects unsupported arguments before updating or stashing', async ({ upgrade, expect }) => {
  await put(join(upgrade.checkout, 'local.txt'), 'local work\n')
  const before = await upgrade.git(['rev-parse', 'HEAD'])
  await upgrade.publish()
  for (const args of [['--unknown'], ['--no-agent'], ['--agent=false'], ['--stash=false'], ['extra']]) {
    const result = await upgrade.run([...args, '--stash'])
    expect(result.status).toBe(1)
  }
  expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(before)
  expect(await upgrade.git(['stash', 'list'])).toBe('')
  expect(await readFile(join(upgrade.checkout, 'local.txt'), 'utf8')).toBe('local work\n')
})

test.concurrent('refuses to update an unrelated package containing the executable', async ({ upgrade, expect }) => {
  const file = join(upgrade.checkout, 'package.json')
  const original = JSON.parse(await readFile(file, 'utf8'))
  await put(file, JSON.stringify({ ...original, name: 'unrelated-project' }))
  const before = await upgrade.git(['rev-parse', 'HEAD'])
  await upgrade.publish()
  const result = await upgrade.run(['--agent', '--stash'])
  expect(result.status).toBe(1)
  expect(result.stdout).toContain('not inside a Woof checkout')
  expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(before)
  expect(await upgrade.git(['stash', 'list'])).toBe('')
  expect(JSON.parse(await readFile(file, 'utf8')).name).toBe('unrelated-project')
})

test.concurrent.for(['stash', 'cleanup', 'pull-and-restore'] as const)(
  'reports completed work before the final error when %s fails',
  async (failure, { cli, upgrade, expect }) => {
    await put(join(upgrade.checkout, 'local.txt'), 'local work\n')
    const before = await upgrade.git(['rev-parse', 'HEAD'])
    const upstream = await upgrade.publish()
    const wrapper = join(cli.bin, 'git')
    const patterns = {
      stash: '*" stash push "*',
      cleanup: '*" stash drop "*',
      'pull-and-restore': '*" pull "*|*" stash apply "*',
    }
    await put(
      wrapper,
      `#!/bin/sh\ncase " $* " in\n${patterns[failure]}) echo 'Simulated Git failure.' >&2; exit 1;;\nesac\nexec /usr/bin/git "$@"\n`,
    )
    await chmod(wrapper, 0o755)

    const result = await upgrade.run(['--stash'])
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain(' Failed.')
    expect(result.stdout).not.toContain('Upgrade needs attention')
    if (failure === 'stash') {
      expect(result.stdout).toContain('Could not stash local changes.')
      expect(result.stdout).not.toContain('Local changes stashed.')
      expect(result.stdout).not.toContain('Upgraded from')
      expect(await upgrade.git(['stash', 'list'])).toBe('')
      expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(before)
      expect(await readFile(join(upgrade.checkout, 'local.txt'), 'utf8')).toBe('local work\n')
    } else {
      const stash = await upgrade.git(['stash', 'list', '--format=%H'])
      expect(stash).toMatch(/^[a-f0-9]{40}$/)
      expect(await upgrade.git(['show', `${stash}:local.txt`])).toBe('local work')
      if (failure === 'cleanup') {
        expect(result.stdout).toMatch(
          /Upgraded from[\s\S]*Local changes and staged state restored\.[\s\S]*Verify the restored changes/,
        )
        expect(
          result.stdout
            .trim()
            .endsWith(`Local changes restored, but the recovery stash could not be removed: ${stash}.`),
        ).toBe(true)
        expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(upstream)
        expect(await readFile(join(upgrade.checkout, 'local.txt'), 'utf8')).toBe('local work\n')
      } else {
        expect(result.stdout).toContain('Could not pull the checkout.')
        expect(
          result.stdout.trim().endsWith(`Could not restore local changes. Recovery stash retained: ${stash}.`),
        ).toBe(true)
        expect(result.stdout).not.toContain('Local changes and staged state restored.')
        expect(result.stdout).not.toContain('Upgraded from')
        expect(await upgrade.git(['rev-parse', 'HEAD'])).toBe(before)
      }
    }
  },
)
