import type { ConfigurationMigrationInput } from '../utils/migrations.ts'
import type { RegisteredProject } from '../utils/projects.ts'

import { defineCommand } from 'citty'
import { readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { discoverResources } from '../utils/discovery.ts'
import { shellQuote } from '../utils/display.ts'
import { migrateConfigurationDocuments } from '../utils/migrations.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, presentError, presentSelection, writePayload } from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader, detectCheckoutRoot, resolveResourceLocation } from '../utils/resources.ts'
import { createScriptEvaluator } from '../utils/scripts.ts'
import { createTokenGraph, resolveToken, splitProjectAddress } from '../utils/tokens.ts'

function insideHome(cwd: string) {
  try {
    const path = relative(realpathSync(getWoofHome()), realpathSync(cwd))
    return path === '' || (!path.startsWith(`..${sep}`) && path !== '..')
  } catch {
    return false
  }
}

function migrationInputs(rootData: unknown, cwd: string): ConfigurationMigrationInput[] {
  const inputs: ConfigurationMigrationInput[] = [{ file: getWoofHome('woof.config.json'), kind: 'root' }]
  const projects =
    rootData && typeof rootData === 'object' && !Array.isArray(rootData)
      ? (rootData as Record<string, unknown>)['$projects']
      : undefined
  if (projects && typeof projects === 'object' && !Array.isArray(projects)) {
    const checkoutRoot = detectCheckoutRoot(cwd)
    for (const reference of Object.values(projects)) {
      if (typeof reference === 'string')
        inputs.push({
          file: resolveResourceLocation(reference, checkoutRoot ? { repoRoot: checkoutRoot } : {}).file,
          kind: 'project',
        })
    }
  }

  const checkoutRoot = detectCheckoutRoot(cwd)
  if (checkoutRoot && !insideHome(cwd)) {
    const candidates = [
      resolve(checkoutRoot, 'woof.config.json'),
      resolve(checkoutRoot, '.agents/woof.config.json'),
      resolve(checkoutRoot, '.claude/woof.config.json'),
    ]
    const physical = new Map<string, string>()
    for (const candidate of candidates) {
      try {
        physical.set(realpathSync(candidate), candidate)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (physical.size > 1)
      throw new Error(`Multiple distinct repository configurations exist: ${[...physical.values()].join(', ')}.`)
    const [repository] = physical.keys()
    if (repository) inputs.push({ file: repository, kind: 'project' })
  }
  return inputs
}

function candidateText(
  candidates: ReturnType<typeof discoverResources>,
  project: RegisteredProject | undefined,
  agent: boolean,
) {
  return candidates
    .map(candidate => {
      const metadata = [
        candidate.kind,
        candidate.description,
        candidate.tags?.length ? `tags: ${candidate.tags.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('  ')
      const followUp = `woof get ${shellQuote(candidate.path)}${project ? ` --project ${shellQuote(project.name)}` : ''}${agent ? ' --agent' : ''}`
      return `${candidate.path}  ${metadata}\n  ${followUp}`
    })
    .join('\n')
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
    project: { description: 'Select a registered project', type: 'string' },
    query: { description: 'Exact token address or discovery terms', type: 'positional', required: false },
    search: { description: 'Discover metadata without executing a match', type: 'boolean' },
  },
  meta: { description: 'Resolve an exact token or discover resources', name: 'get' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          migrate: { type: 'boolean' },
          project: { type: 'string' },
          search: { type: 'boolean' },
        },
      })
      const agent = values.agent === true || Boolean(isAgent())
      const query = positionals.join(' ')
      const qualified =
        positionals.length === 1 && query.startsWith('$projects.') ? splitProjectAddress(query) : undefined
      if (qualified?.project && values.project && qualified.project !== values.project)
        throw new Error(
          `Qualified address selects ${qualified.project}, which contradicts --project ${values.project}.`,
        )
      const explicitProject = qualified?.project ?? values.project
      const search = values.search === true
      const migration = values.migrate === true

      if (migration) {
        const rootData: unknown = JSON.parse(readFileSync(getWoofHome('woof.config.json'), 'utf8'))
        if (explicitProject) {
          const projects =
            rootData && typeof rootData === 'object' && !Array.isArray(rootData)
              ? (rootData as Record<string, unknown>)['$projects']
              : undefined
          if (
            !projects ||
            typeof projects !== 'object' ||
            Array.isArray(projects) ||
            !Object.prototype.hasOwnProperty.call(projects, explicitProject)
          )
            throw new Error(`Unknown registered project: ${explicitProject}.`)
        }
        await migrateConfigurationDocuments(migrationInputs(rootData, process.cwd()))
      }

      let context = selectProjectContext({
        ...(explicitProject ? { project: explicitProject } : {}),
        loader: createResourceLoader({ cwd: process.cwd() }),
      })
      if (context.selection === 'ambiguous') {
        const candidates = context.candidates
        if (!agent && process.stdout.isTTY) {
          const selected = await chooseOption({
            message: 'Select the project for this lookup',
            options: candidates.map(candidate => ({ value: candidate.name, label: candidate.name })),
          })
          if (!selected) {
            process.exitCode = 130
            return
          }
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          presentSelection({
            summary: 'Multiple projects match this lookup. Select one explicitly.',
            details: candidates
              .map(candidate => {
                const retry = `woof get ${query ? shellQuote(query) : ''} --project ${shellQuote(candidate.name)}${agent ? ' --agent' : ''}`
                return `${candidate.name}\n  ${retry}`
              })
              .join('\n'),
            recovery: 'Retry with one exact --project value. No selection was persisted.',
          })
          process.exitCode = 1
          return
        }
      }

      const graph = createTokenGraph(context)
      const exactPath = qualified?.path ?? query
      const exact = Boolean(query) && !search && graph.tokens.has(exactPath)
      if (exact) {
        const output = await resolveToken(graph, query, createScriptEvaluator({ checkoutRoot: context.checkoutRoot }))
        writePayload(output)
        return
      }

      const candidates = discoverResources(graph, query)
      const project = context.project?.kind === 'registered' ? context.project : undefined
      const details = candidateText(candidates, project, agent)
      if (search || !query || agent || !process.stdout.isTTY || candidates.length === 0) {
        presentSelection({
          summary: candidates.length ? 'Matching resources' : 'No resources matched this lookup.',
          details,
          recovery: search
            ? 'Use an exact follow-up command to retrieve a selected resource. Discovery never executes a match.'
            : 'Use an exact token address or broaden the discovery terms, then retry.',
        })
        if (!search && query) process.exitCode = 1
        return
      }

      const selected = await chooseOption({
        message: 'Select a resource to resolve',
        options: candidates.map(candidate => ({
          value: candidate.path,
          label: candidate.path,
          ...(candidate.description ? { hint: candidate.description } : {}),
        })),
      })
      if (!selected) {
        process.exitCode = 130
        return
      }
      const selectedCandidate = candidates.find(candidate => candidate.path === selected)!
      const output = await resolveToken(
        graph,
        selectedCandidate.path,
        createScriptEvaluator({ checkoutRoot: context.checkoutRoot }),
      )
      writePayload(output)
    } catch (error) {
      presentError({
        summary: 'Woof could not complete the lookup.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Review the reported source and recovery details. Use woof get --search to inspect candidates, or retry with an exact token address and explicit project selection.',
      })
      process.exitCode = 1
    }
  },
})
