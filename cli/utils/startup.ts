import type { ConfigurationKind } from './config.ts'

import { lstatSync, readFileSync, realpathSync } from 'node:fs'

import { initializeWoofHome } from './bootstrap.ts'
import {
  orderConfigurationText,
  parseConfigurationDocument,
  readConfigurationDocument,
  replaceFileContent,
} from './config.ts'
import { applyConfigurationMigration, prepareConfigurationMigration, withConfigurationLock } from './migrations.ts'
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
  const documents: { file: string; kind: ConfigurationKind }[] = rootExists ? [{ file: rootFile, kind: 'root' }] : []
  const known = new Map<string, string>(rootExists ? [[realpathSync(rootFile), 'root']] : [])
  const add = (file: string, kind: 'project' | 'repository') => {
    const physical = realpathSync(file)
    const existing = known.get(physical)
    if (existing === 'root') throw new Error(`Configuration has conflicting root and project roles: ${file}`)
    if (!existing) {
      known.set(physical, kind)
      documents.push({ file, kind })
    }
  }

  if (root && '$projects' in root && root.$projects) {
    for (const reference of Object.values(root.$projects)) {
      if (typeof reference !== 'string') continue
      add(resolveResourceLocation(reference, checkout ? { repoRoot: checkout } : {}).file, 'project')
    }
  }
  if (checkout && !insideWoofHome(options.cwd)) {
    const repo = repositoryConfiguration(checkout)
    if (repo) add(repo, 'repository')
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
        if (document.kind === 'root') readConfigurationDocument(document.file, 'root')
        else readConfigurationDocument(document.file, document.kind)
    }
  } else {
    for (const document of documents)
      if (document.kind !== 'root') readConfigurationDocument(document.file, document.kind)
  }

  if (!options.passive || options.migrate) {
    // A broken project must prevent ordering writes to every configuration.
    const ordered = documents.map(({ file, kind }) => {
      const target = realpathSync(file)
      const source = readFileSync(target, 'utf8')
      if (kind === 'root') parseConfigurationDocument(source, kind, file)
      else parseConfigurationDocument(source, kind, file)
      return { file, target, source, content: orderConfigurationText(source) }
    })
    for (const document of ordered) {
      if (document.source === document.content) continue
      await withConfigurationLock(document.file, target => {
        if (target !== document.target)
          throw new Error(`Configuration changed location while ordering fields: ${document.file}. Retry.`)
        const current = readFileSync(target, 'utf8')
        if (current === document.content) return
        if (current !== document.source)
          throw new Error(`Configuration changed while ordering fields: ${document.file}. Retry.`)
        replaceFileContent(target, document.content, current)
      })
    }
  }
}
