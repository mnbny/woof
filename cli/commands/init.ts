import type { ProjectMetadata } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import * as v from 'valibot'

import template from '../templates/woof.config.json' with { type: 'json' }
import { isAgent } from '../utils/agent.ts'
import { parseConfigurationDocument, validateConfigurationDocument } from '../utils/config.ts'
import { shellQuote } from '../utils/display.ts'
import { withConfigurationLock } from '../utils/migrations.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, enterText, presentError, presentResult, presentSelection } from '../utils/presentation.ts'
import { insideWoofHome, normalizedMetadataPath, repositoryConfiguration } from '../utils/projects.ts'
import { detectCheckoutRoot } from '../utils/resources.ts'
import { tokenNameSchema } from '../utils/schema.ts'
import { isTTY } from '../utils/terminal.ts'

const LOCATIONS = ['woof.config.json', '.agents/woof.config.json', '.claude/woof.config.json']

// Inline projects travel in exports, and the ~/ form still fits the home of the developer who imports them.
function homeRelative(path: string) {
  const home = homedir()
  return path.startsWith(`${home}${sep}`) ? `~/${path.slice(home.length + 1)}` : path
}

function splitList(value: string) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function createRepositoryConfiguration(checkout: string, location: string) {
  const existing = repositoryConfiguration(checkout)
  if (existing) throw new Error(`This checkout already has a repository configuration: ${existing}`)
  const file = join(checkout, location)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(template, null, 2)}\n`, { flag: 'wx' })
  return file
}

function registerProject(name: string, metadata: ProjectMetadata) {
  return withConfigurationLock(getWoofHome('woof.config.json'), target => {
    const source = readFileSync(target, 'utf8')
    const current = parseConfigurationDocument(source, 'root', target)
    if (Object.hasOwn(current.$projects ?? {}, name))
      throw new Error(`Registered project ${name} already exists in ${target}.`)
    // Extend the parsed source rather than the validated copy, so the file keeps its key order.
    const raw = JSON.parse(source) as Record<string, unknown>
    const projects = raw['$projects'] as Record<string, unknown> | undefined
    const next = {
      ...raw,
      $projects: { ...projects, [name]: Object.keys(metadata).length ? { $metadata: metadata } : {} },
    }
    validateConfigurationDocument(next, 'root', target)
    const staging = join(dirname(target), `.${basename(target)}.${randomUUID()}.init.tmp`)
    const { mode } = statSync(target)
    try {
      writeFileSync(staging, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode })
      chmodSync(staging, mode & 0o7777)
      renameSync(staging, target)
    } finally {
      rmSync(staging, { force: true })
    }
    return target
  })
}

function handoff(summary: string, details: string, template: string, values: Record<string, string>) {
  presentSelection(
    { summary, details, recovery: 'Retry with one exact command. Nothing was written.' },
    { template, values },
  )
  process.exitCode = 1
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    repo: { description: 'Create a repository configuration in this checkout', type: 'boolean' },
    location: { description: 'Repository configuration file in the checkout', type: 'positional', required: false },
    name: { description: 'Register a project in Woof home under this name', type: 'string' },
    'base-path': { description: 'Checkout base path of the registered project (repeatable)', type: 'string' },
    'worktree-path': { description: 'Worktree pattern of the registered project (repeatable)', type: 'string' },
  },
  meta: { description: 'Create a project configuration', name: 'init' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          repo: { type: 'boolean' },
          name: { type: 'string' },
          'base-path': { type: 'string', multiple: true },
          'worktree-path': { type: 'string', multiple: true },
        },
      })
      const agent = values.agent === true || Boolean(isAgent())
      const interactive = !agent && isTTY()
      const suffix = agent ? ' --agent' : ''
      let location = positionals[0]
      let name = values.name
      let basePaths = values['base-path'] ?? []
      let worktreePaths = values['worktree-path'] ?? []
      const pathsGiven = basePaths.length > 0 || worktreePaths.length > 0
      if (values.repo && (name !== undefined || pathsGiven))
        throw new Error('--repo cannot be combined with --name, --base-path or --worktree-path.')
      if (name === undefined && pathsGiven) throw new Error('--base-path and --worktree-path require --name.')
      if (location !== undefined && !LOCATIONS.includes(location))
        throw new Error(`The repository location must be one of: ${LOCATIONS.join(', ')}.`)

      const cwd = process.cwd()
      const checkout = detectCheckoutRoot(cwd)
      const suggestion = homeRelative(checkout ?? cwd)
      const homeCommand = `woof init --name NAME --base-path ${shellQuote(suggestion)}${suffix}`
      let target: string | undefined = values.repo ? 'repo' : name !== undefined || !checkout ? 'home' : undefined

      if (!target) {
        if (!interactive) {
          const repository = LOCATIONS.map(path => `woof init --repo ${path}${suffix}`).join('\n')
          return handoff(
            'Choose where to create the project configuration.',
            `Repository configuration in ${checkout}:\n${repository}\n\nRegistered project in Woof home:\n${homeCommand}`,
            'init-target',
            { checkout: checkout!, repository, home: homeCommand },
          )
        }
        const selected = await chooseOption({
          message: 'Where should the project configuration live?',
          options: [
            { value: 'repo', label: 'This repository', hint: checkout! },
            { value: 'home', label: 'Woof home', hint: 'a registered project, selected by its paths' },
          ],
        })
        if (!selected) {
          process.exitCode = 130
          return
        }
        target = selected
      }

      if (target === 'repo') {
        if (insideWoofHome(cwd))
          throw new Error('Woof ignores repository configuration inside Woof home. Run init from a project checkout.')
        if (!checkout)
          throw new Error('init --repo needs a Git checkout. Register a Woof home project with --name instead.')
        if (location === undefined) {
          if (!interactive) {
            const commands = LOCATIONS.map(path => `woof init --repo ${path}${suffix}`).join('\n')
            return handoff(
              `Choose the location of the repository configuration in ${checkout}.`,
              commands,
              'init-location',
              { checkout, commands },
            )
          }
          const selected = await chooseOption({
            message: 'Which file should hold the repository configuration?',
            options: LOCATIONS.map(path => ({ value: path, label: path })),
          })
          if (!selected) {
            process.exitCode = 130
            return
          }
          location = selected
        }
        const file = createRepositoryConfiguration(checkout, location)
        presentResult(
          {
            summary: 'Created a repository configuration.',
            details: `File: ${file}`,
            recovery:
              'Add project tokens beside $schemaVersion. Git shares the file with everyone who uses the checkout.',
          },
          { template: 'init-repository', values: { file } },
        )
        return
      }

      if (name === undefined) {
        if (!interactive)
          return handoff('Choose a name for the registered project.', homeCommand, 'init-home', {
            command: homeCommand,
          })
        const folder = basename(checkout ?? cwd)
        name = await enterText('Project name', v.is(tokenNameSchema, folder) ? { initialValue: folder } : {})
        if (name === undefined) {
          process.exitCode = 130
          return
        }
      }
      const parsedName = v.safeParse(tokenNameSchema, name)
      if (!parsedName.success) throw new Error(`Project name ${name}: ${parsedName.issues[0].message}`)

      if (interactive && !pathsGiven) {
        const base = await enterText('Checkout base paths, separated by commas (optional)', {
          initialValue: suggestion,
          optional: true,
        })
        if (base === undefined) {
          process.exitCode = 130
          return
        }
        const worktree = await enterText('Worktree patterns, separated by commas (optional)', { optional: true })
        if (worktree === undefined) {
          process.exitCode = 130
          return
        }
        basePaths = splitList(base)
        worktreePaths = splitList(worktree)
      }
      for (const path of [...basePaths, ...worktreePaths]) normalizedMetadataPath(path, name)

      const file = await registerProject(name, {
        ...(basePaths.length ? { $basePaths: basePaths } : {}),
        ...(worktreePaths.length ? { $worktreePaths: worktreePaths } : {}),
      })
      const checkouts = basePaths.join(', ') || 'none'
      const worktrees = worktreePaths.join(', ') || 'none'
      presentResult(
        {
          summary: `Registered project ${name}.`,
          details: `Configuration: ${file}\nCheckout base paths: ${checkouts}\nWorktree patterns: ${worktrees}`,
          recovery: `Add project tokens under $projects.${name}. Woof selects the project in directories that match its paths. Without paths, select it with --project ${name}.`,
        },
        { template: 'init-registered', values: { name, file, checkouts, worktrees } },
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'Woof could not create the project configuration.',
          details,
          recovery: 'Correct the reported problem, then retry. Existing configuration was not changed.',
        },
        { template: 'init-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
