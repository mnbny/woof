import type { ConfigurationMigrationInput } from './migrations.ts'

import { lstatSync, realpathSync } from 'node:fs'

import { initializeWoofHome } from './bootstrap.ts'
import { readConfigurationDocument } from './config.ts'
import { applyConfigurationMigration, prepareConfigurationMigration } from './migrations.ts'
import { getWoofHome } from './paths.ts'
import { presentWarning } from './presentation.ts'
import { insideWoofHome, repositoryConfiguration } from './projects.ts'
import { detectCheckoutRoot, resolveResourceLocation } from './resources.ts'

function pathExists(file: string) {
  try {
    lstatSync(file)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function prepareStartup(options: { migrate: boolean; passive: boolean; cwd: string }) {
  const rootFile = getWoofHome('woof.config.json')
  if (!pathExists(rootFile)) {
    if (!options.passive || options.migrate) await initializeWoofHome()
  }

  const rootExists = pathExists(rootFile)
  const rootPlan =
    rootExists && options.migrate ? prepareConfigurationMigration([{ file: rootFile, kind: 'root' }]) : undefined
  const root = rootExists
    ? (rootPlan?.documents[0]!.migrated ?? readConfigurationDocument(rootFile, 'root'))
    : undefined
  const checkout = detectCheckoutRoot(options.cwd)
  const documents: ConfigurationMigrationInput[] = rootExists ? [{ file: rootFile, kind: 'root' }] : []
  const known = new Map<string, string>(rootExists ? [[realpathSync(rootFile), 'root']] : [])
  const add = (file: string) => {
    const physical = realpathSync(file)
    const existing = known.get(physical)
    if (existing === 'root') throw new Error(`Configuration has conflicting root and project roles: ${file}`)
    if (!existing) {
      known.set(physical, 'project')
      documents.push({ file, kind: 'project' })
    }
  }

  if (root && '$projects' in root && root.$projects) {
    for (const reference of Object.values(root.$projects)) {
      if (typeof reference !== 'string') continue
      add(resolveResourceLocation(reference, checkout ? { repoRoot: checkout } : {}).file)
    }
  }
  if (checkout && !insideWoofHome(options.cwd)) {
    const repo = repositoryConfiguration(checkout)
    if (repo) add(repo)
  }

  if (options.migrate) {
    const plan = prepareConfigurationMigration(documents)
    if (
      rootPlan &&
      (plan.documents[0]?.source !== rootPlan.documents[0]?.source ||
        plan.documents[0]?.target !== rootPlan.documents[0]?.target)
    )
      throw new Error('Root configuration changed while identifying migration documents; retry.')
    if (plan.documents.some(document => document.changed)) {
      const changed = await applyConfigurationMigration(plan)
      for (const document of changed)
        presentWarning('migration-notice', { file: document.file, from: document.from, to: document.to })
      for (const document of documents)
        if (document.kind === 'project') readConfigurationDocument(document.file, 'project')
        else readConfigurationDocument(document.file, 'root')
    }
  } else {
    for (const document of documents)
      if (document.kind === 'project') readConfigurationDocument(document.file, 'project')
  }
}
