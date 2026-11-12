import type { BundleFile } from '../utils/bundles.ts'
import type { Resource } from '../utils/schema.ts'

import { defineCommand } from 'citty'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isDeepStrictEqual, parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { createBundleArchive } from '../utils/bundles.ts'
import { serializeConfigurationDocument, validateConfigurationDocument } from '../utils/config.ts'
import { fieldsText, inlineCodeText, shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'
import { chooseOption, presentCancel, presentCode, presentError, presentResult } from '../utils/presentation.ts'
import { isPrivateToken, PRIVATE_MARKER } from '../utils/private.ts'
import { checkoutPath, loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, preflightTokenGraph, splitProjectAddress, TokenResolutionError } from '../utils/tokens.ts'

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
    paths: { description: 'Token, namespace, or $projects.NAME paths to export', type: 'positional', required: false },
  },
  meta: { description: 'Export tokens, namespaces, or registered projects and their dependencies', name: 'export' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
        },
      })
      const agent = values.agent === true || Boolean(isAgent())
      if (!positionals.length && !agent && process.stdout.isTTY) {
        const loader = createResourceLoader({ cwd: process.cwd() })
        const projects = loadRegisteredProjects(loader.loadRootConfiguration(), loader)
        if (!projects.length)
          throw new Error(`No project is registered. Register one with ${inlineCodeText('woof init')}.`)
        const projectName = await chooseOption({
          message: 'Project to export',
          options: projects.map(project => {
            const path = checkoutPath(project)
            return { value: project.name, label: project.name, ...(path ? { hint: path } : {}) }
          }),
        })
        if (!projectName) return presentCancel('Export cancelled. Nothing was written.')
        positionals.push(`$projects.${projectName}`)
      }
      if (!positionals.length)
        throw new Error('Supply token or namespace paths, or $projects.NAME for a whole registered project.')

      const selections = new Map<string, { whole: boolean; paths: Set<string> }>()
      for (const address of positionals) {
        const whole = address.startsWith('$projects.') && address.split('.').length === 2
        const parsed = splitProjectAddress(whole ? `${address}.placeholder` : address)
        const scope = parsed.project ?? ''
        const selection = selections.get(scope) ?? { whole: false, paths: new Set<string>() }
        selection.whole ||= whole
        if (!whole) selection.paths.add(parsed.path)
        selections.set(scope, selection)
      }
      const loader = createResourceLoader({ cwd: process.cwd() })
      const root = loader.loadRootConfiguration()
      const resources = new Map<string, BundleFile>()
      const shared: Record<string, unknown> = {}
      const projects: Record<string, unknown> = {}
      const projectFiles: { name: string; path: string; bytes: Uint8Array }[] = []
      function add(path: string, data: Uint8Array) {
        const existing = resources.get(path)
        if (existing && !Buffer.from(existing.data).equals(Buffer.from(data)))
          throw new Error(`Export resources collide at ${inlineCodeText(path)}. Choose distinct source paths.`)
        resources.set(path, { path, data })
      }
      for (const [scope, selected] of selections) {
        const context = scope
          ? selectProjectContext({ project: scope, loader })
          : { root, candidates: [], checkoutRoot: undefined, selection: 'root' as const }
        const project = context.project
        const graph = createTokenGraph(context)
        const own = [...graph.tokens.values()].filter(token => token.origin === (scope ? 'project' : 'root'))
        const starts = new Set<string>()
        if (selected.whole) for (const token of own) starts.add(token.path)
        for (const path of selected.paths) {
          const matches = own.filter(token => token.path === path || token.path.startsWith(`${path}.`))
          if (!matches.length) {
            const namespaces = scope ? graph.projectNamespaces : graph.rootNamespaces
            throw new Error(
              namespaces.has(path)
                ? `Namespace ${path} contains no tokens.`
                : `No definition exists at ${scope ? `$projects.${scope}.` : ''}${path}.`,
            )
          }
          for (const token of matches) starts.add(token.path)
        }
        // A placeholder has no dependencies. Redact before walking so omitted content cannot pull in more tokens or files.
        for (const [path, token] of graph.tokens)
          if (isPrivateToken(token.value))
            graph.tokens.set(path, { ...token, value: { ...(token.value as Resource), $exec: PRIVATE_MARKER } })
        const validation = preflightTokenGraph(graph, [...starts])
        if (validation.problems.length) throw new TokenResolutionError(validation.problems.join('\n'))
        const reachable = new Map(validation.tokens.map(token => [token.path, token]))
        const exportedProject: Record<string, unknown> = project
          ? selected.whole
            ? structuredClone(project.data)
            : {
                ...(project.data.$schemaVersion ? { $schemaVersion: project.data.$schemaVersion } : {}),
                ...(project.data.$metadata ? { $metadata: structuredClone(project.data.$metadata) } : {}),
              }
          : {}
        const projectSpecific = new Set(
          validation.tokens.filter(token => token.origin === 'project').map(token => token.path),
        )
        const callers = new Map<string, string[]>()
        for (const token of reachable.values())
          for (const target of [...token.references, ...token.deferred])
            callers.set(target, [...(callers.get(target) ?? []), token.path])
        // Follow callers until stable: deferred cycles have no dependency-first ordering.
        for (const path of projectSpecific) for (const caller of callers.get(path) ?? []) projectSpecific.add(caller)
        const rewrite = (value: string | Resource) => {
          const update = (part: string) =>
            part.startsWith('<repo>/') ? `<root>/${scope}-repo-export/${part.slice('<repo>/'.length)}` : part
          return typeof value === 'string'
            ? update(value)
            : ({
                ...value,
                $exec: Array.isArray(value.$exec) ? value.$exec.map(update) : update(value.$exec),
              } as Resource)
        }
        for (const token of reachable.values()) {
          putToken(
            projectSpecific.has(token.path) ? exportedProject : shared,
            token.path,
            rewrite(graph.tokens.get(token.path)!.value),
          )
          for (const location of token.files) {
            const path = location.markedPath.startsWith('<root>/')
              ? location.markedPath.slice('<root>/'.length)
              : `${scope}-repo-export/${location.markedPath.slice('<repo>/'.length)}`
            add(path, readFileSync(location.file))
          }
        }
        if (project) {
          const definition = root.data.$projects![scope]!
          if (typeof definition === 'string') {
            const bytes = isDeepStrictEqual(exportedProject, project.data)
              ? readFileSync(project.source.file)
              : Buffer.from(serializeConfigurationDocument(exportedProject))
            projectFiles.push({ name: scope, path: definition.slice('<root>/'.length), bytes })
          } else projects[scope] = exportedProject
        }
      }
      for (const file of projectFiles) {
        let path = file.path
        let suffix = 0
        while (resources.has(path) && !Buffer.from(resources.get(path)!.data).equals(Buffer.from(file.bytes))) {
          suffix++
          path = `${file.name}-project-export${suffix === 1 ? '' : `-${suffix}`}/${file.path}`
        }
        add(path, file.bytes)
        projects[file.name] = `<root>/${path}`
      }
      const configuration = validateConfigurationDocument(
        {
          $schemaVersion: root.data.$schemaVersion,
          ...shared,
          ...(Object.keys(projects).length ? { $projects: projects } : {}),
        },
        'root',
        'export payload',
      )
      const label = positionals.join(', ')
      const name = selections.size === 1 ? [...selections.keys()][0] || positionals[0]! : 'tokens'
      const archive = createBundleArchive(configuration, resources.values())
      const destination = writeUniqueArchive(name, archive)
      presentResult(
        {
          summary: `Exported ${inlineCodeText(label)}.`,
          details: fieldsText([
            ['Archive', destination],
            ['Files', String(resources.size)],
          ]),
        },
        {
          template: 'export-result',
          values: {
            project: label,
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
