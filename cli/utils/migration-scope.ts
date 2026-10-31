import type { ConfigurationMigrationInput } from './migrations.ts'
import type { ConfigurationSource, createResourceLoader } from './resources.ts'
import type { ProjectConfiguration, RootConfiguration } from './schema.ts'

import { readFileSync, realpathSync } from 'node:fs'

import { getWoofHome } from './paths.ts'
import { selectProjectContext } from './projects.ts'
import { detectCheckoutRoot, resolveResourceLocation } from './resources.ts'

type ResourceLoader = ReturnType<typeof createResourceLoader>

export function migrationInputs(
  rootData: unknown,
  cwd: string,
  explicitProject?: string,
): ConfigurationMigrationInput[] {
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
