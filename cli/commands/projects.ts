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
      const details = [
        `Selection: ${context.selection}`,
        context.project
          ? `Current scope: ${context.project.kind === 'repository' ? 'unnamed repository (not a registered export)' : context.project.name}`
          : 'Current scope: root only',
        context.candidates.length
          ? `Matching candidates: ${context.candidates.map(candidate => candidate.name).join(', ')}`
          : 'Matching candidates: none',
        '',
        ...projects.flatMap(project => [
          `${project.name} [${project.inline ? 'inline' : 'referenced'}]`,
          `  Configuration: ${project.source.file}`,
          `  Resource root: ${project.source.root}`,
          ...metadataPaths(project.data.$metadata?.$basePaths).map(path => `  Checkout: ${path}`),
          ...metadataPaths(project.data.$metadata?.$worktreePaths).map(path => `  Worktree pattern: ${path}`),
        ]),
      ].join('\n')

      presentResult({
        summary: projects.length
          ? `${projects.length} registered project${projects.length === 1 ? '' : 's'}`
          : 'No registered projects',
        details: projects.length
          ? details
          : 'Add a registered project to the home registry or define an unnamed project in a repository configuration.',
        recovery:
          'Selection is not persisted. Unnamed repository scope is distinct from named, exportable registry entries.',
      })
    } catch (error) {
      presentError({
        summary: 'Woof could not list projects.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Review the configuration paths and selection information, then retry. No project selection was persisted.',
      })
      process.exitCode = 1
    }
  },
})
