import { cancel, intro, log, outro, spinner } from '@clack/prompts'
import { defineCommand } from 'citty'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { inlineCodeText, shellQuote } from '../utils/display.ts'
import { getWoofRoot } from '../utils/paths.ts'

const run = promisify(execFile)

const STEPS = {
  check: { running: 'Checking for updates', failure: 'Could not check for updates.' },
  stash: { running: 'Stashing local changes', failure: 'Could not stash local changes.' },
  pull: { running: 'Pulling checkout', failure: 'Could not pull the checkout.' },
  restore: { running: 'Restoring local changes', failure: 'Could not restore local changes.' },
  dependencies: { running: 'Installing source dependencies', failure: 'Could not install source dependencies.' },
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const message =
    error.message.replace(/^Command failed:.*(?:\n|$)/, '').trim() ||
    ('code' in error ? `Process exited with code ${String(error.code)}.` : error.message)
  return error.cause ? `${message}\n${errorMessage(error.cause)}` : message
}

export default defineCommand({
  args: {
    agent: { description: 'Upgrade without terminal interaction and print agent guidance', type: 'boolean' },
    stash: { description: 'Stash local changes before upgrading and restore them afterward', type: 'boolean' },
  },
  meta: { description: 'Upgrade the checkout that supplies the running Woof CLI', name: 'upgrade' },
  async run({ args, rawArgs }) {
    const agent = args.agent === true || Boolean(isAgent())
    let humanReport = false
    let root = 'Unavailable'
    let branch = 'unknown'
    let pull = 'Not attempted.'
    let restoration = 'No stash created.'
    let dependencies = 'Not needed.'
    let guidance = ''
    let changes = ''
    let blockedByChanges = false
    const errors: string[] = []
    let completedStep = ''

    function showCompletedStep() {
      if (completedStep && !agent) log.success(completedStep)
      completedStep = ''
    }

    async function git(args: string[]) {
      const { stdout } = await run('git', ['-c', 'color.ui=false', ...args], {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      return stdout.trimEnd()
    }

    async function progress<T>(
      step: keyof typeof STEPS,
      completed: string | ((result: T) => string),
      action: () => Promise<T>,
    ) {
      showCompletedStep()
      const indicator = agent ? undefined : spinner({ withGuide: false })
      indicator?.start(STEPS[step].running)
      try {
        const result = await action()
        indicator?.clear()
        // Hold the completion until another step starts, or use it as the final success message.
        completedStep = typeof completed === 'function' ? completed(result) : completed
        return result
      } catch (error) {
        // Clearing avoids Clack's success marker on a failed step.
        indicator?.clear()
        throw new Error(STEPS[step].failure, { cause: error })
      }
    }

    async function dependencyInputs() {
      return Promise.all(
        ['package.json', 'pnpm-lock.yaml'].map(file =>
          readFile(join(root, file), 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined
            throw error
          }),
        ),
      )
    }

    async function upgradeCheckout() {
      const { values } = parseArgs({
        args: rawArgs,
        options: { agent: { type: 'boolean' }, stash: { type: 'boolean' } },
      })
      if (!agent) {
        intro('woof upgrade')
        humanReport = true
      }

      root = getWoofRoot()
      const gitRoot = await git(['rev-parse', '--show-toplevel'])
      if ((await realpath(gitRoot)) !== (await realpath(root)))
        throw new Error('The Woof checkout must be the root of its own Git repository or worktree.')
      branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '')
      if (!branch) throw new Error('Detached HEAD. Check out the branch to upgrade, then retry.')
      if (!agent) log.info(`Checkout: ${root}\nBranch: ${branch}`)

      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => {
        throw new Error('The current branch has no upstream. Configure its upstream, then retry.')
      })
      const remote = await git(['config', '--get', `branch.${branch}.remote`])
      const before = await git(['rev-parse', 'HEAD'])
      const incoming = await progress(
        'check',
        count => (count === '0' ? '' : 'Update available.'),
        async () => {
          await git(['fetch', '--quiet', remote])
          // A branch ahead of upstream needs no update, even though the tips differ.
          return git(['rev-list', '--count', `${before}..@{upstream}`])
        },
      )
      if (incoming === '0') {
        pull = 'Already current.'
        return
      }

      changes = await git(['status', '--short', '--untracked-files=all'])
      if (changes && !values.stash) {
        blockedByChanges = true
        guidance = agent
          ? 'Ask the user whether to stash the listed local changes, upgrade this checkout, and restore the changes afterward. This includes staged changes, unstaged changes, and untracked files.\n\nReuse explicit permission already given in this conversation. Do not treat a general request to upgrade as permission to stash.\n\nWith permission, retry woof upgrade --agent --stash through the same Woof entry point. The CLI performs the Git operations and restores staged state. If restoration conflicts, it keeps the stash for recovery.\n\nIf the user declines, leave the checkout unchanged. The user can commit or stash the changes separately before retrying.'
          : 'Commit or stash these changes, or retry with:\n  woof upgrade --stash'
        throw new Error('Local changes block the upgrade. Nothing was changed.')
      }
      const sourceMode = import.meta.url.endsWith('.ts')
      const inputs = sourceMode ? await dependencyInputs() : []
      let stash: string | undefined
      try {
        if (changes) {
          const marker = `woof-upgrade-${randomUUID()}`
          await progress(
            'stash',
            () => `Local changes stashed. Recovery stash: ${stash}`,
            async () => {
              try {
                await git(['stash', 'push', '--include-untracked', '--message', marker])
              } finally {
                // The stash list is shared by worktrees. Find our unique entry, never assume stash@{0}.
                const entries = await git(['stash', 'list', '--format=%H %gs'])
                stash = entries
                  .split('\n')
                  .find(entry => entry.endsWith(`: ${marker}`))
                  ?.split(' ')[0]
                if (stash) {
                  const recovery = `git -C ${shellQuote(root)} stash apply --index ${stash}`
                  guidance = `Recovery stash: ${stash}\nIf interrupted, inspect the checkout before restoring it with:\n${recovery}`
                  if (agent) process.stdout.write(`${guidance}\n\n`)
                }
              }
              if (!stash) throw new Error('No upgrade stash was created. The checkout was not pulled.')
              if (await git(['status', '--porcelain', '--untracked-files=all']))
                throw new Error('Local changes remain after stashing. The checkout was not pulled.')
            },
          )
        }

        try {
          // Disable configured autostash and rebasing: this command owns preservation and recovery.
          await progress(
            'pull',
            () => pull.replace(/([a-f0-9]{7})[a-f0-9]{33}/g, '$1'),
            async () => {
              await git([
                '-c',
                'merge.autoStash=false',
                '-c',
                'rebase.autoStash=false',
                'pull',
                '--ff-only',
                '--no-rebase',
              ])
              const after = await git(['rev-parse', 'HEAD'])
              pull = before === after ? 'Already current.' : `Upgraded from ${before} to ${after}.`
            },
          )
        } catch (error) {
          pull = 'Failed. Resolve the Git error before retrying.'
          throw error
        }
      } catch (error) {
        errors.push(errorMessage(error))
      } finally {
        if (stash) {
          const stashId = stash
          let restored = false
          try {
            await progress('restore', 'Local changes and staged state restored.', () =>
              git(['stash', 'apply', '--index', stashId]),
            )
            restored = true
            restoration = 'Local changes and staged state restored.'
            // Resolve the current selector only after restoration, so older stashes stay untouched.
            const entries = await git(['stash', 'list', '--format=%H %gd'])
            const selector = entries
              .split('\n')
              .find(entry => entry.startsWith(`${stash} `))
              ?.split(' ')[1]
            if (selector) await git(['stash', 'drop', selector])
            guidance = ''
          } catch (error) {
            restoration = restored
              ? `Local changes restored, but the recovery stash could not be removed: ${stash}.`
              : `Could not restore local changes. Recovery stash retained: ${stash}.`
            guidance = restored
              ? `Verify the restored changes before removing recovery stash ${stash}.`
              : agent
                ? `Inspect git status in ${shellQuote(root)} and resolve any conflicts. The checkout may already be upgraded.\nDo not apply the stash again over partially restored changes. Keep stash ${stash} until all changes are recovered.`
                : `Inspect ${inlineCodeText('git status')} and resolve any conflicts.\nDo not apply the stash again over partially restored changes.`
            errors.push(agent ? `${restoration}\n${errorMessage(error)}` : restoration)
          }
        }
      }

      if (sourceMode) {
        const after = await dependencyInputs()
        if (inputs.some((value, index) => value !== after[index])) {
          if (errors.length) {
            dependencies = 'Not installed because the upgrade needs recovery.'
            guidance += `\nAfter recovery, run ${inlineCodeText('pnpm install --frozen-lockfile')} in ${shellQuote(root)} before using the source CLI.`
          } else {
            dependencies = 'Installation failed.'
            guidance = `Run ${inlineCodeText('pnpm install --frozen-lockfile')} in ${shellQuote(root)} before using the source CLI.`
            await progress('dependencies', 'Source dependencies installed.', () =>
              run('pnpm', ['install', '--frozen-lockfile'], { cwd: root, env: { ...process.env, CI: '1' } }),
            )
            dependencies = 'Installed from the checkout lockfile.'
            guidance = ''
          }
        }
      }
    }

    try {
      await upgradeCheckout()
    } catch (error) {
      errors.push(errorMessage(error))
    }

    if (errors.length) process.exitCode = 1
    if (agent) {
      const values = {
        checkout: root,
        branch: branch || 'detached',
        pull,
        restoration,
        dependencies,
        changes: changes || (pull === 'Already current.' ? 'Not inspected; no update is needed.' : 'None.'),
        guidance: guidance ? `## Next action\n\n${guidance}` : '',
        errors: errors.length ? `## Errors\n\n${errors.join('\n')}` : '',
      }
      process.stdout.write(
        `# Woof upgrade\n\nCheckout: ${values.checkout} Branch: ${values.branch}\n\n` +
          `Pull: ${values.pull} Restoration: ${values.restoration} Dependencies: ${values.dependencies}\n\n` +
          `## Local changes before upgrade\n\n${values.changes}\n\n${values.guidance}\n\n${values.errors}\n`,
      )
    } else if (humanReport) {
      if (errors.length) {
        showCompletedStep()
        const context = [blockedByChanges ? `Local changes:\n${changes}` : '', guidance].filter(Boolean)
        if (context.length) log.warn(context.join('\n\n'))
        cancel(errors.join('\n'))
      } else {
        outro(completedStep || pull)
      }
    } else {
      console.error(errors.join('\n'))
    }
  },
})
