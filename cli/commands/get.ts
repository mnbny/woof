import type { preflightToken } from '../utils/tokens.ts'

import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { discoverResources } from '../utils/discovery.ts'
import { inlineCodeText, mutedText, runtimeBadge, scopeBadge, shellQuote } from '../utils/display.ts'
import {
  aliasedMetadata,
  chooseOption,
  chooseToken,
  presentCancel,
  presentError,
  presentNotice,
  presentSelection,
  presentWarning,
  writePayload,
} from '../utils/presentation.ts'
import { checkoutPath, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createScriptEvaluator } from '../utils/scripts.ts'
import { createTokenGraph, resolveToken, splitProjectAddress } from '../utils/tokens.ts'

function warnOnRepositoryHomeDependencies(explanation: ReturnType<typeof preflightToken>) {
  if (explanation.project?.kind !== 'repository') return
  if (!explanation.tokens.some(token => token.origin === 'project')) return
  const usesHome = explanation.tokens.some(
    token =>
      token.origin === 'root' ||
      (token.origin === 'project' && token.files.some(file => file.markedPath.startsWith('<root>/'))),
  )
  if (usesHome) presentWarning('get-home-dependencies')
}

function candidateText(
  graph: ReturnType<typeof createTokenGraph>,
  candidates: ReturnType<typeof discoverResources>,
  agent: boolean,
) {
  const width = agent ? 0 : Math.max(...candidates.map(candidate => candidate.path.length))
  // Agents learn that an alias resolves to another token. People see what the alias is for.
  const all = discoverResources(graph)
  return candidates
    .map(candidate => {
      const { description, tags } = agent ? candidate : aliasedMetadata(candidate, all)
      const metadata = [
        candidate.target && agent ? `alias of ${candidate.target}` : undefined,
        description,
        tags?.length ? `tags: ${tags.join(', ')}` : undefined,
      ]
        .filter(Boolean)
        .join('  ')
      const runtime = candidate.target ? '' : runtimeBadge(candidate.kind)
      const badges = `${scopeBadge(candidate.origin)}${runtime ? ` ${runtime}` : ''}`
      return `${agent ? '- ' : ''}${candidate.path.padEnd(width)}  ${badges}${metadata ? `  ${mutedText(metadata)}` : ''}`
    })
    .join('\n')
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
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
          `Qualified address selects ${inlineCodeText(qualified.project)}, which contradicts ${inlineCodeText(`--project ${values.project}`)}.`,
        )
      const explicitProject = qualified?.project ?? values.project
      const search = values.search === true

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
            message: 'Project to use',
            options: candidates.map(candidate => {
              const path = checkoutPath(candidate)
              return { value: candidate.name, label: candidate.name, ...(path ? { hint: path } : {}) }
            }),
          })
          if (!selected) return presentCancel('Lookup cancelled.')
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          const details = candidates
            .map(candidate => {
              const path = checkoutPath(candidate)
              const name = `${agent ? '- ' : ''}${candidate.name}`
              return path ? `${name}  ${mutedText(path)}` : name
            })
            .join('\n')
          const command = `woof get${query ? ` ${shellQuote(query)}` : ''}${search ? ' --search' : ''} --project NAME${agent ? ' --agent' : ''}`
          presentSelection(
            {
              summary: 'Several projects match this directory.',
              details,
              recovery: `Retry with ${inlineCodeText(command)}, with NAME replaced by the project name.`,
            },
            { template: 'get-ambiguous', values: { projects: details, command } },
          )
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
          warnOnRepositoryHomeDependencies,
        )
        writePayload(output)
        return
      }

      if (!agent && process.stdout.isTTY && graph.tokens.size) {
        const selected = await chooseToken({
          message: 'Token to get',
          tokens: discoverResources(graph),
          query: exactPath,
        })
        if (!selected) return presentCancel('Lookup cancelled.')
        writePayload(
          await resolveToken(
            graph,
            selected,
            createScriptEvaluator({ checkoutRoot: context.checkoutRoot, signal: controller.signal }),
            warnOnRepositoryHomeDependencies,
          ),
        )
        return
      }

      const candidates = discoverResources(graph, exactPath)
      const project = context.project?.kind === 'registered' ? context.project : undefined
      const details = candidateText(graph, candidates, agent)
      const projectFlag = project ? ` --project ${shellQuote(project.name)}` : ''
      const command = `woof get 'PATH'${projectFlag}${agent ? ' --agent' : ''}`
      const searchCommand = `woof get 'TERMS' --search${projectFlag}${agent ? ' --agent' : ''}`
      const template = search
        ? candidates.length
          ? 'get-search'
          : 'get-search-empty'
        : candidates.length
          ? 'get-candidates'
          : 'get-no-match'
      presentSelection(
        {
          summary: candidates.length
            ? search
              ? 'Matching resources'
              : 'No token has this exact address. These resources match:'
            : 'No resources matched this lookup.',
          details,
          recovery: candidates.length
            ? `Get a token with ${inlineCodeText(command)}.`
            : `Search with other terms: ${inlineCodeText(searchCommand)}.`,
        },
        { template, values: { candidates: details, command, search: searchCommand } },
      )
      if (!search && query) process.exitCode = 1
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      if (controller.signal.aborted) {
        presentNotice(
          {
            summary: 'woof lookup was cancelled.',
            details,
            recovery: 'Earlier completed effects are not rolled back.',
          },
          { template: 'get-cancelled', values: { details } },
        )
        process.exitCode = 130
      } else {
        presentError(
          {
            summary: 'woof could not complete the lookup.',
            details,
            recovery: `Search the tokens with ${inlineCodeText('woof get')}.`,
          },
          { template: 'get-error', values: { details } },
        )
        process.exitCode = 1
      }
    } finally {
      process.removeListener('SIGINT', onCancel)
      process.removeListener('SIGTERM', onCancel)
    }
  },
})
