import type { ConfigurationMigrationInput } from '../utils/migrations.ts'
import type { RegisteredProject } from '../utils/projects.ts'
import type { ConfigurationSource } from '../utils/resources.ts'
import type { ProjectConfiguration, RootConfiguration } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { readFileSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { initializeWoofHome } from '../utils/bootstrap.ts'
import { discoverResources } from '../utils/discovery.ts'
import { shellQuote } from '../utils/display.ts'
import { migrateConfigurationDocuments } from '../utils/migrations.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, presentError, presentSelection, writePayload } from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader, detectCheckoutRoot, resolveResourceLocation } from '../utils/resources.ts'
import { createScriptEvaluator } from '../utils/scripts.ts'
import { createTokenGraph, resolveToken, splitProjectAddress } from '../utils/tokens.ts'

type ResourceLoader = ReturnType<typeof createResourceLoader>

function migrationInputs(rootData: unknown, cwd: string, explicitProject?: string): ConfigurationMigrationInput[] {
  const rootFile = getWoofHome('woof.config.json')
  const checkoutRoot = detectCheckoutRoot(cwd)
  const inputs: ConfigurationMigrationInput[] = [{ file: rootFile, kind: 'root' }]
  const projects =
    rootData && typeof rootData === 'object' && !Array.isArray(rootData)
      ? (rootData as Record<string, unknown>)['$projects']
      : undefined

  if (explicitProject) {
    const definition =
      projects && typeof projects === 'object' && !Array.isArray(projects)
        ? (projects as Record<string, unknown>)[explicitProject]
        : undefined
    if (typeof definition === 'string')
      inputs.push({
        file: resolveResourceLocation(definition, checkoutRoot ? { repoRoot: checkoutRoot } : {}).file,
        kind: 'project',
      })
    return inputs
  }

  const rootSource: ConfigurationSource = {
    file: realpathSync(rootFile),
    root: realpathSync(getWoofHome()),
    rootKind: 'root',
    markedPath: rootFile,
    kind: 'root',
  }
  const inspectionLoader: ResourceLoader = {
    repoRoot: checkoutRoot,
    loadRootConfiguration() {
      return { data: rootData as RootConfiguration, source: rootSource }
    },
    loadProjectConfiguration(reference: string) {
      const provenance = resolveResourceLocation(reference, checkoutRoot ? { repoRoot: checkoutRoot } : {})
      return {
        data: JSON.parse(readFileSync(provenance.file, 'utf8')) as ProjectConfiguration,
        source: { ...provenance, kind: 'project' },
      }
    },
    loadRepositoryConfiguration(file: string) {
      if (!checkoutRoot) throw new Error(`No active checkout supplies ${file}.`)
      const physical = realpathSync(file)
      return {
        data: JSON.parse(readFileSync(physical, 'utf8')) as ProjectConfiguration,
        source: {
          file: physical,
          root: checkoutRoot,
          rootKind: 'repo',
          markedPath: file,
          kind: 'project',
        },
      }
    },
    readResource(reference: string) {
      const provenance = resolveResourceLocation(reference, checkoutRoot ? { repoRoot: checkoutRoot } : {})
      return { content: readFileSync(provenance.file, 'utf8'), provenance }
    },
  }
  const context = selectProjectContext({ loader: inspectionLoader, cwd })
  const candidates = context.project ? [context.project] : context.candidates
  for (const candidate of candidates)
    if (!candidate.inline) inputs.push({ file: candidate.source.file, kind: 'project' })
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
    const controller = new AbortController()
    const onCancel = () => controller.abort()
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
        await initializeWoofHome()
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
        await migrateConfigurationDocuments(migrationInputs(rootData, process.cwd(), explicitProject))
      }

      process.on('SIGINT', onCancel)
      process.on('SIGTERM', onCancel)

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
        const output = await resolveToken(
          graph,
          query,
          createScriptEvaluator({ checkoutRoot: context.checkoutRoot, signal: controller.signal }),
        )
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
        createScriptEvaluator({ checkoutRoot: context.checkoutRoot, signal: controller.signal }),
      )
      writePayload(output)
    } catch (error) {
      if (controller.signal.aborted) {
        presentError({
          summary: 'Woof lookup was cancelled.',
          details: error instanceof Error ? error.message : String(error),
          recovery: 'Owned child cleanup has finished. Earlier completed effects are not rolled back.',
        })
        process.exitCode = 130
      } else {
        presentError({
          summary: 'Woof could not complete the lookup.',
          details: error instanceof Error ? error.message : String(error),
          recovery:
            'Review the reported source and recovery details. Use woof get --search to inspect candidates, or retry with an exact token address and explicit project selection.',
        })
        process.exitCode = 1
      }
    } finally {
      process.removeListener('SIGINT', onCancel)
      process.removeListener('SIGTERM', onCancel)
    }
  },
})
