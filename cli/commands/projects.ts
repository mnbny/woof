import { defineCommand } from 'citty'
import { homedir } from 'node:os'
import { basename, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { badgeText, fieldsText, inlineBadge, inlineCodeText, listFieldText } from '../utils/display.ts'
import { presentError, presentResult } from '../utils/presentation.ts'
import { loadRegisteredProjects, projectMatches, selectedProjectText, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'

// Each color is an entry of the 256-color palette, so terminals without true color show it unchanged.
const CURRENT_COLOR = '#afd7ff'
const MATCH_COLOR = '#dadada'

type ProjectRow = {
  name: string
  kind: 'repo' | 'registered'
  badge?: string
  config: string
  inline: boolean
  basePaths: string[]
  worktreePaths: string[]
}

function metadataPaths(paths: string[] | undefined) {
  return (paths ?? []).map(path =>
    path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path,
  )
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
  },
  meta: { description: 'List the detected project and the registered projects', name: 'projects' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: { agent: { type: 'boolean' } },
      })
      if (positionals.length) throw new Error('Projects does not accept positional arguments.')
      const agent = values.agent === true || Boolean(isAgent())

      const cwd = process.cwd()
      const loader = createResourceLoader({ cwd })
      const root = loader.loadRootConfiguration()
      const projects = loadRegisteredProjects(root, loader)
      const context = selectProjectContext({ cwd, loader })
      const current = 'project' in context ? context.project : undefined
      const matching = new Set(projects.filter(project => projectMatches(project, cwd)).map(project => project.name))

      // The detected project comes first. A registered project that covers this directory but lost to the repository
      // configuration, or that ties with another, is marked as a match.
      const selected = selectedProjectText(context)
      const summary = selected
        ? `Current project: ${selected}`
        : context.selection === 'ambiguous'
          ? `Several projects match this directory. Pick one with ${inlineCodeText('--project NAME')}.`
          : 'No project detected. Only shared tokens apply.'
      const rows: ProjectRow[] = [
        ...(current?.kind === 'repository'
          ? [
              {
                name: basename(context.checkoutRoot!),
                kind: 'repo' as const,
                badge: 'current',
                config: current.source.file,
                inline: false,
                basePaths: [],
                worktreePaths: [],
              },
            ]
          : []),
        ...[...projects]
          .sort(
            (left, right) =>
              Number(right.name === current?.name) - Number(left.name === current?.name) ||
              Number(matching.has(right.name)) - Number(matching.has(left.name)),
          )
          .map(project => {
            const badge =
              project.name === current?.name
                ? 'current'
                : matching.has(project.name)
                  ? current
                    ? 'also matches'
                    : 'matches'
                  : undefined
            return {
              name: project.name,
              kind: 'registered' as const,
              ...(badge ? { badge } : {}),
              config: project.source.file,
              inline: project.inline,
              basePaths: metadataPaths(project.data.$metadata?.$basePaths),
              worktreePaths: metadataPaths(project.data.$metadata?.$worktreePaths),
            }
          }),
      ]

      const list = rows.length
        ? rows
            .map(row => {
              const badge = row.badge
                ? `  ${badgeText(row.badge, row.badge === 'current' ? CURRENT_COLOR : MATCH_COLOR)}`
                : ''
              const heading = agent
                ? `- ${row.name} (${[row.kind, row.badge].filter(Boolean).join(', ')})`
                : `${row.name}${badge}`
              const inline = row.inline ? `  ${inlineBadge()}` : ''
              return [
                heading,
                `  ${fieldsText([['Configuration', row.config]])}${inline}`,
                ...[
                  ...listFieldText('Base path', row.basePaths),
                  ...listFieldText('Worktree path', row.worktreePaths),
                ].map(line => `  ${line}`),
              ].join('\n')
            })
            .join('\n')
        : `No projects. To create one, run ${inlineCodeText(`woof init${agent ? ' --agent' : ''}`)}.`

      presentResult({ summary, details: list }, { template: 'projects-result', values: { summary, list } })
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        { summary: 'woof could not list projects.', details },
        { template: 'projects-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
