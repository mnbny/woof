import type { BundleFile } from '../utils/bundles.ts'
import type { Resource } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual, parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { createBundleArchive } from '../utils/bundles.ts'
import { validateConfigurationDocument } from '../utils/config.ts'
import { fieldsText, inlineCodeText, shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, presentCancel, presentCode, presentError, presentResult } from '../utils/presentation.ts'
import { isPrivateToken, PRIVATE_MARKER } from '../utils/private.ts'
import { checkoutPath, loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, preflightToken } from '../utils/tokens.ts'

function putToken(document: Record<string, unknown>, path: string, value: string | Resource) {
  const parts = path.split('.')
  let namespace = document
  for (const part of parts.slice(0, -1)) {
    namespace[part] ??= {}
    namespace = namespace[part] as Record<string, unknown>
  }
  namespace[parts.at(-1)!] = value
}

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

      const graph = createTokenGraph(context)
      // A placeholder has no dependencies. Redact before walking so omitted content cannot pull in more tokens or files.
      for (const [path, token] of graph.tokens)
        if (isPrivateToken(token.value))
          graph.tokens.set(path, { ...token, value: { ...(token.value as Resource), $exec: PRIVATE_MARKER } })
      const validations = [...graph.tokens.values()]
        .filter(token => token.origin === 'project')
        .map(token => preflightToken(graph, token.path))
      const reachable = new Map(
        validations.flatMap(validation => validation.tokens.map(token => [token.path, token] as const)),
      )
      const resources = new Map<string, BundleFile>()
      function add(path: string, data: Uint8Array) {
        const existing = resources.get(path)
        if (existing && !Buffer.from(existing.data).equals(Buffer.from(data)))
          throw new Error(`Export resources collide at ${inlineCodeText(path)}. Choose distinct source paths.`)
        resources.set(path, { path, data })
      }
      function rewrite(value: string | Resource) {
        const update = (part: string) =>
          part.startsWith('<repo>/') ? `<root>/${projectName}-repo-export/${part.slice('<repo>/'.length)}` : part
        if (typeof value === 'string') return update(value)
        return {
          ...value,
          $exec: Array.isArray(value.$exec) ? value.$exec.map(update) : update(value.$exec),
        } as Resource
      }
      const exportedProject = structuredClone(project.data)
      const shared: Record<string, unknown> = {}
      const projectSpecific = new Set<string>()
      // Preflight lists dependencies before their callers. A shared caller of a project override must travel with
      // the project too; otherwise the exported shared catalog would depend on a project-only token.
      for (const token of reachable.values()) {
        const inProject = token.origin === 'project' || token.references.some(path => projectSpecific.has(path))
        if (inProject) projectSpecific.add(token.path)
        putToken(inProject ? exportedProject : shared, token.path, rewrite(graph.tokens.get(token.path)!.value))
        for (const location of token.files) {
          const path = location.markedPath.startsWith('<root>/')
            ? location.markedPath.slice('<root>/'.length)
            : `${projectName}-repo-export/${location.markedPath.slice('<repo>/'.length)}`
          add(path, readFileSync(location.file))
        }
      }
      const configuration = validateConfigurationDocument(
        {
          $schemaVersion: context.root.data.$schemaVersion,
          ...shared,
          $projects: { [projectName]: typeof definition === 'string' ? definition : exportedProject },
        },
        'root',
        'export payload',
      )
      if (!project.inline && typeof definition === 'string') {
        const path = definition.slice('<root>/'.length)
        const bytes = isDeepStrictEqual(exportedProject, project.data)
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
