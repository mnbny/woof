import type { BundleFile } from '../utils/bundles.ts'
import type { ProjectDefinition } from '../utils/projects.ts'
import type { Resource, TokenValue } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { createBundleArchive } from '../utils/bundles.ts'
import { validateConfigurationDocument } from '../utils/config.ts'
import { shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'
import { presentError, presentResult } from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, validateTokenGraph } from '../utils/tokens.ts'

function writeUniqueArchive(project: string, archive: Uint8Array) {
  const directory = getWoofHome('exports')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '' : `-${attempt}`
    const destination = getWoofHome('exports', `${project}${suffix}.woof.zip`)
    try {
      writeFileSync(destination, archive, { flag: 'wx', mode: 0o600 })
      return destination
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      rmSync(destination, { force: true })
      throw error
    }
  }
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
    project: { description: 'Registered project to export', type: 'string' },
  },
  meta: { description: 'Export a registered project and required resources', name: 'export' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          migrate: { type: 'boolean' },
          project: { type: 'string' },
        },
      })
      if (positionals.length) throw new Error('Export accepts no positional arguments; use --project NAME.')
      const projectName = values.project
      if (!projectName)
        throw new Error(
          'Export requires an explicit registered --project; repository-defined projects cannot be exported.',
        )
      const agent = values.agent === true || Boolean(isAgent())

      const context = selectProjectContext({
        project: projectName,
        loader: createResourceLoader({ cwd: process.cwd() }),
      })
      const project = context.project
      if (!project || project.kind !== 'registered')
        throw new Error('Repository-defined projects cannot be exported; select a registered home project explicitly.')
      const definition = context.root.data.$projects?.[projectName]
      if (!definition) throw new Error(`Registered project ${projectName} has no exportable definition.`)
      if (typeof definition === 'string' && !definition.startsWith('<root>/'))
        throw new Error('Repository-defined project configuration cannot be exported. Use a home-registered project.')

      const originalConfiguration = validateConfigurationDocument(
        { ...context.root.data, $projects: { [projectName]: definition } },
        'root',
        'export payload',
      )
      const originalContext = { ...context, root: { ...context.root, data: originalConfiguration } }
      const rootOnlyContext = {
        root: originalContext.root,
        candidates: [],
        checkoutRoot: originalContext.checkoutRoot,
        selection: 'root' as const,
      }
      const validations = [
        ...validateTokenGraph(createTokenGraph(rootOnlyContext)),
        ...validateTokenGraph(createTokenGraph(originalContext)),
      ]
      const resources = new Map<string, BundleFile>()
      function add(path: string, data: Uint8Array) {
        const existing = resources.get(path)
        if (existing && !Buffer.from(existing.data).equals(Buffer.from(data)))
          throw new Error(`Export resources collide at ${path}. Choose distinct source paths.`)
        resources.set(path, { path, data })
      }
      for (const validation of validations) {
        for (const token of validation.tokens) {
          for (const location of token.files) {
            const path = location.markedPath.startsWith('<root>/')
              ? location.markedPath.slice('<root>/'.length)
              : `${projectName}-repo-export/${location.markedPath.slice('<repo>/'.length)}`
            add(path, readFileSync(location.file))
          }
        }
      }
      function rewrite(value: TokenValue): TokenValue {
        if (typeof value === 'string')
          return value.startsWith('<repo>/')
            ? `<root>/${projectName}-repo-export/${value.slice('<repo>/'.length)}`
            : value
        if ('$type' in value || '$exec' in value) {
          const resource = value as Resource
          const update = (part: string) =>
            part.startsWith('<repo>/') ? `<root>/${projectName}-repo-export/${part.slice('<repo>/'.length)}` : part
          return {
            ...resource,
            $exec: Array.isArray(resource.$exec) ? resource.$exec.map(update) : update(resource.$exec),
          } as Resource
        }
        return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, rewrite(child)]))
      }
      const exportedProject = Object.fromEntries(
        Object.entries(project.data).map(([key, value]) => [
          key,
          key.startsWith('$') ? value : rewrite(value as TokenValue),
        ]),
      ) as ProjectDefinition
      const configuration = validateConfigurationDocument(
        {
          ...context.root.data,
          $projects: { [projectName]: typeof definition === 'string' ? definition : exportedProject },
        },
        'root',
        'export payload',
      )
      if (!project.inline && typeof definition === 'string') {
        const path = definition.slice('<root>/'.length)
        const bytes =
          JSON.stringify(exportedProject) === JSON.stringify(project.data)
            ? readFileSync(project.source.file)
            : Buffer.from(`${JSON.stringify(exportedProject, null, 2)}\n`)
        add(path, bytes)
      }

      const archive = createBundleArchive(configuration, resources.values())
      const destination = writeUniqueArchive(projectName, archive)
      presentResult({
        summary: `Exported ${projectName} without executing scripts.`,
        details: [`Project: ${projectName}`, `Archive: ${destination}`, `Resources: ${resources.size}`].join('\n'),
        recovery: `Import this archive with woof import ${shellQuote(destination)}${agent ? ' --agent' : ''}.`,
      })
    } catch (error) {
      presentError({
        summary: 'Woof could not export the project.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Select an explicit registered project, correct any missing resources or invalid references, then retry. Source configuration was not changed.',
      })
      process.exitCode = 1
    }
  },
})
