import type { ProjectMetadata } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { parseArgs } from 'node:util'
import * as v from 'valibot'

import template from '../templates/woof.config.json' with { type: 'json' }
import { isAgent } from '../utils/agent.ts'
import { parseConfigurationDocument, replaceConfigurationFile, validateConfigurationDocument } from '../utils/config.ts'
import { fieldsText, hintText, inlineBadge, inlineCodeText, listFieldText, shellQuote } from '../utils/display.ts'
import { withConfigurationLock } from '../utils/migrations.ts'
import { getWoofHome } from '../utils/paths.ts'
import {
  chooseOption,
  enterText,
  presentCancel,
  presentError,
  presentResult,
  presentSelection,
} from '../utils/presentation.ts'
import { insideWoofHome, normalizedMetadataPath, repositoryConfiguration } from '../utils/projects.ts'
import { detectCheckoutRoot } from '../utils/resources.ts'
import { tokenNameSchema } from '../utils/schema.ts'
import { isTTY } from '../utils/terminal.ts'

const LOCATIONS = ['woof.config.json', '.agents/woof.config.json', '.claude/woof.config.json']
const LOCATION_HINTS: Record<string, string> = {
  'woof.config.json': 'at the checkout root',
  '.agents/woof.config.json': 'in the .agents folder',
  '.claude/woof.config.json': 'in the .claude folder',
}

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
  if (existing) throw new Error(`This checkout already has a repository configuration: ${inlineCodeText(existing)}`)
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
      throw new Error(`Registered project ${inlineCodeText(name)} already exists in ${inlineCodeText(target)}.`)
    // Extend the parsed source rather than the validated copy, so the file keeps its key order.
    const raw = JSON.parse(source) as Record<string, unknown>
    const projects = raw['$projects'] as Record<string, unknown> | undefined
    const next = {
      ...raw,
      $projects: { ...projects, [name]: Object.keys(metadata).length ? { $metadata: metadata } : {} },
    }
    validateConfigurationDocument(next, 'root', target)
    replaceConfigurationFile(target, next)
    return target
  })
}

function handoff(summary: string, details: string, template: string, values: Record<string, string>) {
  presentSelection({ summary, details, recovery: 'Retry with one exact command.' }, { template, values })
  process.exitCode = 1
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    repo: { description: 'Create a repository configuration in this checkout', type: 'boolean' },
    location: { description: 'Repository configuration file in the checkout', type: 'positional', required: false },
    name: { description: 'Register a project in woof home under this name', type: 'string' },
    'base-path': { description: 'Base path of the registered project (repeatable)', type: 'string' },
    'worktree-path': { description: 'Worktree path of the registered project (repeatable)', type: 'string' },
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
        throw new Error(
          `${inlineCodeText('--repo')} cannot be combined with ${inlineCodeText('--name')}, ${inlineCodeText('--base-path')} or ${inlineCodeText('--worktree-path')}.`,
        )
      if (name === undefined && pathsGiven)
        throw new Error(
          `${inlineCodeText('--base-path')} and ${inlineCodeText('--worktree-path')} require ${inlineCodeText('--name')}.`,
        )
      if (location !== undefined && !LOCATIONS.includes(location))
        throw new Error(
          `The repository location must be one of: ${LOCATIONS.map(path => inlineCodeText(path)).join(', ')}.`,
        )

      const cwd = process.cwd()
      const checkout = detectCheckoutRoot(cwd)
      const suggestion = homeRelative(checkout ?? cwd)
      const homeCommand = `woof init --name NAME --base-path ${shellQuote(suggestion)}${suffix}`
      let target: string | undefined = values.repo ? 'repo' : name !== undefined || !checkout ? 'home' : undefined

      if (!target) {
        if (!interactive) {
          const repository = `woof init --repo LOCATION${suffix}\nLocations: ${LOCATIONS.join(', ')}`
          return handoff(
            'Choose where to create the project configuration.',
            `In this repo (shared with the team): ${checkout}\n${repository}\n\nIn woof home (only you): ${getWoofHome('woof.config.json')}\n${homeCommand}`,
            'init-target',
            { checkout: checkout!, repository, home: homeCommand, rootFile: getWoofHome('woof.config.json') },
          )
        }
        const selected = await chooseOption({
          message: 'Where should the project configuration live?',
          options: [
            { value: 'repo', label: 'in this repo (shared with the team)', hint: checkout! },
            { value: 'home', label: 'in woof home (only you)', hint: getWoofHome('woof.config.json') },
          ],
        })
        if (!selected) return presentCancel('Init cancelled. Nothing was changed.')
        target = selected
      }

      if (target === 'repo') {
        if (insideWoofHome(cwd))
          throw new Error('woof ignores repository configuration inside woof home. Run init from a project checkout.')
        if (!checkout)
          throw new Error(
            `${inlineCodeText('init --repo')} needs a Git checkout. Register a woof home project with ${inlineCodeText('--name')} instead.`,
          )
        if (location === undefined) {
          if (!interactive) {
            const commands = `woof init --repo LOCATION${suffix}\nLocations: ${LOCATIONS.join(', ')}`
            return handoff(
              `Choose the location of the repository configuration in ${checkout}.`,
              commands,
              'init-location',
              { checkout, commands },
            )
          }
          const selected = await chooseOption({
            message: 'Which file should hold the repository configuration?',
            options: LOCATIONS.map(path => ({ value: path, label: path, hint: LOCATION_HINTS[path]! })),
          })
          if (!selected) return presentCancel('Init cancelled. Nothing was changed.')
          location = selected
        }
        const file = createRepositoryConfiguration(checkout, location)
        presentResult(
          {
            summary: 'Created a repository configuration.',
            details: fieldsText([['File', file]]),
            recovery: `To add a token, run ${inlineCodeText(`woof add --repo${suffix}`)}.`,
          },
          { template: 'init-repository', values: { file, add: `woof add --repo${suffix}` } },
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
        if (name === undefined) return presentCancel('Init cancelled. Nothing was changed.')
      }
      const parsedName = v.safeParse(tokenNameSchema, name)
      if (!parsedName.success) throw new Error(`Project name ${inlineCodeText(name)}: ${parsedName.issues[0].message}`)

      if (interactive && !pathsGiven) {
        const base = await enterText(`Base paths ${hintText('comma separated - optional')}`, {
          initialValue: suggestion,
          optional: true,
        })
        if (base === undefined) return presentCancel('Init cancelled. Nothing was changed.')
        const worktree = await enterText(`Worktree paths ${hintText('comma separated - optional')}`, {
          optional: true,
        })
        if (worktree === undefined) return presentCancel('Init cancelled. Nothing was changed.')
        basePaths = splitList(base)
        worktreePaths = splitList(worktree)
      }
      for (const path of [...basePaths, ...worktreePaths]) normalizedMetadataPath(path, name)

      const file = await registerProject(name, {
        ...(basePaths.length ? { $basePaths: basePaths } : {}),
        ...(worktreePaths.length ? { $worktreePaths: worktreePaths } : {}),
      })
      const fields = [
        `${fieldsText([['Configuration', file]])}  ${inlineBadge()}`,
        ...listFieldText('Base path', basePaths),
        ...listFieldText('Worktree path', worktreePaths),
      ].join('\n')
      const add = `woof add --project ${shellQuote(name)}${suffix}`
      presentResult(
        {
          summary: `Registered project ${inlineCodeText(name)}.`,
          details: fields,
          recovery: `To add a token, run ${inlineCodeText(add)}.`,
        },
        { template: 'init-registered', values: { name, fields, add } },
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'woof could not create the project configuration.',
          details,
        },
        { template: 'init-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
