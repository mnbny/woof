import type { BundleFile } from '../utils/bundles.ts'

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
import { createTokenGraph, validateTokenGraphForTransfer } from '../utils/tokens.ts'

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

      const configuration = validateConfigurationDocument(
        {
          ...context.root.data,
          $projects: { [projectName]: definition },
        },
        'root',
        'export payload',
      )
      const prunedContext = { ...context, root: { ...context.root, data: configuration } }
      const rootOnlyContext = {
        root: prunedContext.root,
        candidates: [],
        checkoutRoot: prunedContext.checkoutRoot,
        selection: 'root' as const,
      }
      const validations = [
        ...validateTokenGraphForTransfer(createTokenGraph(rootOnlyContext)),
        ...validateTokenGraphForTransfer(createTokenGraph(prunedContext)),
      ]
      const resources = new Map<string, BundleFile>()
      for (const validation of validations) {
        for (const token of validation.tokens) {
          for (const location of token.files) {
            if (!location.markedPath.startsWith('<root>/')) continue
            const path = location.markedPath.slice('<root>/'.length)
            if (!resources.has(path)) resources.set(path, { path, data: readFileSync(location.file) })
          }
        }
      }
      if (!project.inline && typeof definition === 'string') {
        const path = definition.slice('<root>/'.length)
        resources.set(path, { path, data: readFileSync(project.source.file) })
      }

      const archive = createBundleArchive(configuration, resources.values())
      const destination = writeUniqueArchive(projectName, archive)
      const deferred = [
        ...new Set(
          validations
            .flatMap(validation => validation.deferredRequirements ?? [])
            .map(requirement => requirement.reference),
        ),
      ].sort()
      presentResult({
        summary: `Exported ${projectName} without executing scripts.`,
        details: [
          `Project: ${projectName}`,
          `Archive: ${destination}`,
          `Resources: ${resources.size}`,
          `Checkout requirements: ${deferred.length ? deferred.join(', ') : 'None'}`,
        ].join('\n'),
        recovery: `${deferred.length ? `Checkout resources require normal validation in the target checkout: woof validate --project ${shellQuote(projectName)}. ` : ''}Import this archive with woof import ${shellQuote(destination)}${agent ? ' --agent' : ''}.`,
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
