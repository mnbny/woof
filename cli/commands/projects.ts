import { defineCommand } from 'citty'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { presentError, presentResult } from '../utils/presentation.ts'
import { loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'

function metadataPaths(paths: string[] | undefined) {
  return (paths ?? []).map(path =>
    path === '~' ? homedir() : path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path,
  )
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
  },
  meta: { description: 'List registered projects and their paths', name: 'projects' },
  async run({ rawArgs }) {
    try {
      const { positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: { agent: { type: 'boolean' } },
      })
      if (positionals.length) throw new Error('Projects does not accept positional arguments.')

      const loader = createResourceLoader({ cwd: process.cwd() })
      const root = loader.loadRootConfiguration()
      const projects = loadRegisteredProjects(root, loader)
      const context = selectProjectContext({ loader })
      const scope = context.project
        ? context.project.kind === 'repository'
          ? 'unnamed repository (not a registered export)'
          : context.project.name
        : 'root only'
      const candidates = context.candidates.map(candidate => candidate.name).join(', ') || 'none'
      const list = projects
        .flatMap(project => [
          `${project.name} [${project.inline ? 'inline' : 'referenced'}]`,
          `  Configuration: ${project.source.file}`,
          `  Resource root: ${project.source.root}`,
          ...metadataPaths(project.data.$metadata?.$basePaths).map(path => `  Checkout: ${path}`),
          ...metadataPaths(project.data.$metadata?.$worktreePaths).map(path => `  Worktree pattern: ${path}`),
        ])
        .join('\n')
      const projectsNoun = projects.length === 1 ? 'project' : 'projects'

      presentResult(
        {
          summary: projects.length ? `${projects.length} registered ${projectsNoun}` : 'No registered projects',
          details: projects.length
            ? `Selection: ${context.selection}\nCurrent scope: ${scope}\nMatching candidates: ${candidates}\n\n${list}`
            : 'Add a registered project to the home registry or define an unnamed project in a repository configuration.',
          recovery:
            'Selection is not persisted. Unnamed repository scope is distinct from named, exportable registry entries.',
        },
        projects.length
          ? {
              template: 'projects-result',
              values: {
                count: projects.length,
                projects: projectsNoun,
                selection: context.selection,
                scope,
                candidates,
                list,
              },
            }
          : { template: 'projects-empty' },
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'Woof could not list projects.',
          details,
          recovery:
            'Review the configuration paths and selection information, then retry. No project selection was persisted.',
        },
        { template: 'projects-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
