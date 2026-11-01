import type { BundleFile } from '../utils/bundles.ts'
import type { ProjectDefinition } from '../utils/projects.ts'
import type { Resource, TokenValue } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { createBundleArchive } from '../utils/bundles.ts'
import { validateConfigurationDocument } from '../utils/config.ts'
import { fieldsText, inlineCodeText, shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, presentCancel, presentCode, presentError, presentResult } from '../utils/presentation.ts'
import { checkoutPath, loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
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
          project: { type: 'string' },
        },
      })
      if (positionals.length)
        throw new Error(`Export accepts no positional arguments; use ${inlineCodeText('--project NAME')}.`)
      const agent = values.agent === true || Boolean(isAgent())
      let projectName = values.project
      // A person at a terminal picks the registered project. Other callers name it.
      if (!projectName && !agent && process.stdout.isTTY) {
        const loader = createResourceLoader({ cwd: process.cwd() })
        const projects = loadRegisteredProjects(loader.loadRootConfiguration(), loader)
        if (!projects.length)
          throw new Error(`No project is registered. Register one with ${inlineCodeText('woof init')}.`)
        projectName = await chooseOption({
          message: 'Project to export',
          options: projects.map(project => {
            const path = checkoutPath(project)
            return { value: project.name, label: project.name, ...(path ? { hint: path } : {}) }
          }),
        })
        if (!projectName) return presentCancel('Export cancelled. Nothing was written.')
      }
      if (!projectName)
        throw new Error(
          `Name the project with ${inlineCodeText('--project NAME')}. See the registered projects with ${inlineCodeText('woof projects')}. A repository project cannot be exported.`,
        )

      const context = selectProjectContext({
        project: projectName,
        loader: createResourceLoader({ cwd: process.cwd() }),
      })
      const project = context.project
      if (!project || project.kind !== 'registered')
        throw new Error('Repository-defined projects cannot be exported; select a registered home project explicitly.')
      const definition = context.root.data.$projects?.[projectName]
      if (!definition)
        throw new Error(`Registered project ${inlineCodeText(projectName)} has no exportable definition.`)

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
          throw new Error(`Export resources collide at ${inlineCodeText(path)}. Choose distinct source paths.`)
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
      presentResult(
        {
          summary: `Exported ${inlineCodeText(projectName)}.`,
          details: fieldsText([
            ['Archive', destination],
            ['Files', String(resources.size)],
          ]),
        },
        {
          template: 'export-result',
          values: {
            project: projectName,
            archive: destination,
            files: resources.size,
            archiveArgument: shellQuote(destination),
          },
        },
      )
      presentCode('Import it with', `woof import ${shellQuote(destination)}`, null)
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        { summary: 'woof could not export the project.', details },
        { template: 'export-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
