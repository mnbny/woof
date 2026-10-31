import type { ImportApplyReport } from '../utils/import-apply.ts'
import type { ImportChoice, ImportConflict } from '../utils/import-plan.ts'

import { defineCommand } from 'citty'
import { createPatch } from 'diff'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { shellQuote } from '../utils/display.ts'
import { applyImport, ImportApplyError } from '../utils/import-apply.ts'
import { importReviewSources, planImport, reviewImport, verifyImportReviewSources } from '../utils/import-plan.ts'
import { getWoofHome } from '../utils/paths.ts'
import {
  chooseOption,
  enterText,
  presentConflict,
  presentError,
  presentResult,
  presentWarning,
} from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader, detectCheckoutRoot } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'
import { createTokenGraph, validateTokenGraph } from '../utils/tokens.ts'

function text(value: unknown) {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
}

function binaryText(value: Uint8Array) {
  return `Binary content: ${value.byteLength} bytes, SHA-256 ${createHash('sha256').update(value).digest('hex')}\n`
}

function reviewText(value: unknown) {
  return value instanceof Uint8Array ? binaryText(value) : text(value)
}

function conflictDiff(conflict: ImportConflict) {
  if (conflict.kind === 'file') {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    try {
      return createPatch(
        conflict.path,
        decoder.decode(conflict.existing as Uint8Array),
        decoder.decode(conflict.incoming as Uint8Array),
        'Existing',
        'Incoming',
        { context: 3 },
      )
    } catch {
      return `${reviewText(conflict.existing)}\n${reviewText(conflict.incoming)}`
    }
  }
  return createPatch(conflict.path, text(conflict.existing), text(conflict.incoming), 'Existing', 'Incoming', {
    context: 3,
  })
}

type DecisionDocument = {
  archive: string
  choices: Record<string, ImportChoice>
  next?: { id: string }
  conflicts: Pick<ImportConflict, 'id' | 'kind' | 'path' | 'existingDigest' | 'incomingDigest'>[]
  sources: ReturnType<typeof importReviewSources>
}

function decisionDocument(
  plan: ReturnType<typeof planImport>,
  choices: Readonly<Record<string, ImportChoice>>,
  issues: ImportConflict[],
  next?: ImportConflict,
  invalidated: string[] = [],
) {
  const metadata = (item: ImportConflict) => ({
    id: item.id,
    kind: item.kind,
    path: item.path,
    existingDigest: item.existingDigest,
    incomingDigest: item.incomingDigest,
    ...(item.notice ? { notice: item.notice } : {}),
    ...(item.candidates?.length ? { candidates: item.candidates, candidateDetails: item.candidateDetails } : {}),
    ...(item.requiredNewPath ? { requiredNewPath: true } : {}),
  })
  return {
    archive: plan.archiveDigest,
    sources: importReviewSources(plan),
    choices: { ...choices },
    next: next ? metadata(next) : undefined,
    conflicts: issues.map(metadata),
    ...(invalidated.length ? { invalidated } : {}),
  }
}

function readDecisions(file: string, plan: ReturnType<typeof planImport>): DecisionDocument {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Decisions must be a JSON object.')
  const document = value as DecisionDocument
  if (document.archive !== plan.archiveDigest)
    throw new Error('Decisions belong to a different archive; review this archive again.')
  if (
    !Array.isArray(document.conflicts) ||
    !document.choices ||
    typeof document.choices !== 'object' ||
    Array.isArray(document.choices)
  )
    throw new Error('Decisions require reviewed conflicts and a choices object.')
  verifyImportReviewSources(plan, document.sources)
  const reviewed = new Set(document.conflicts.map(item => item.id))
  for (const id of Object.keys(document.choices))
    if (!reviewed.has(id)) throw new Error(`Decision ${id} was not in the reviewed conflict list.`)
  return document
}

function validateImportedCatalog(cwd: string) {
  const findings: string[] = []
  const loader = createResourceLoader({ cwd })
  let root: ReturnType<typeof loader.loadRootConfiguration>
  try {
    root = loader.loadRootConfiguration()
  } catch (error) {
    return [
      `Could not read ${getWoofHome('woof.config.json')}: ${String(error)}. Repair this configuration before running Woof again.`,
    ]
  }
  const inspect = (name?: string) => {
    const label = name ? `project ${name}` : 'shared tokens'
    try {
      const context = name
        ? selectProjectContext({ project: name, cwd, loader })
        : { root, candidates: [], checkoutRoot: loader.repoRoot, selection: 'root' as const }
      const graph = createTokenGraph(context)
      for (const path of graph.tokens.keys()) {
        try {
          validateTokenGraph(graph, path)
        } catch (error) {
          findings.push(`${label}, ${path}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      findings.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  inspect()
  for (const name of Object.keys(root.data.$projects ?? {})) inspect(name)
  return findings
}

function assertImportContext(cwd: string) {
  const checkout = detectCheckoutRoot(cwd)
  if (!checkout) return
  for (const candidate of ['woof.config.json', '.agents/woof.config.json', '.claude/woof.config.json']) {
    try {
      if (statSync(realpathSync(join(checkout, candidate))).isFile())
        throw new Error('Repository-defined projects cannot be imported. Use a registered home-project context.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
}

function outcome(report: ImportApplyReport) {
  return [
    `Completed: ${report.completed.join(', ') || 'None'}`,
    `Restored: ${report.restored.join(', ') || 'None'}`,
    `Pending: ${report.pending.join(', ') || 'None'}`,
    `Recovery: ${report.recovery.join(', ') || 'None'}`,
    `Warnings: ${report.warnings.join('; ') || 'None'}`,
  ].join('\n')
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    archive: { description: 'Project ZIP archive to import', type: 'positional', required: true },
    decisions: { description: 'Reviewed import choices JSON', type: 'string' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
  },
  meta: { description: 'Review and import a portable project archive', name: 'import' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          decisions: { type: 'string' },
          migrate: { type: 'boolean' },
        },
      })
      if (positionals.length !== 1) throw new Error('Import requires exactly one ARCHIVE path.')
      const cwd = process.cwd()
      const archivePath = resolve(cwd, positionals[0]!)
      const decisionsPath = values.decisions ? resolve(cwd, values.decisions) : undefined
      const agent = values.agent === true || Boolean(isAgent())
      const migration = values.migrate === true ? ' --migrate' : ''
      const archive = readFileSync(archivePath)
      assertImportContext(cwd)

      const plan = planImport(archive, { cwd })
      const prior = decisionsPath ? readDecisions(decisionsPath, plan) : undefined
      const choices: Record<string, ImportChoice> = { ...(prior?.choices ?? {}) }
      let recorded = prior?.conflicts ?? []
      const invalidated: string[] = []
      let reviewed: ReturnType<typeof reviewImport>
      try {
        reviewed = reviewImport(plan, choices)
      } catch (error) {
        const id = prior?.next?.id
        if (!id || !choices[id]) throw error
        delete choices[id]
        invalidated.push(
          `${recorded.find(item => item.id === id)?.path ?? id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        reviewed = reviewImport(plan, choices)
      }
      for (;;) {
        const changed = Object.keys(choices).filter(id => {
          const before = recorded.find(item => item.id === id)
          const now = reviewed.issues.find(item => item.id === id)
          if (now?.invalid) return true
          if (id === prior?.next?.id) return false
          return (
            !before ||
            !now ||
            before.path !== now.path ||
            before.existingDigest !== now.existingDigest ||
            before.incomingDigest !== now.incomingDigest
          )
        })
        if (!changed.length) break
        for (const id of changed) {
          invalidated.push(recorded.find(item => item.id === id)?.path ?? id)
          delete choices[id]
        }
        reviewed = reviewImport(plan, choices)
      }
      for (;;) {
        if (reviewed.status === 'ready') break
        const item = reviewed.next
        presentConflict({
          summary: `Review ${item.kind} ${item.path}`,
          details: `${conflictDiff(item)}${item.notice ? `\n${item.notice}` : ''}${item.candidates?.length ? `\nReusable (existing metadata is retained): ${JSON.stringify(item.candidateDetails ?? item.candidates)}` : ''}${invalidated.length ? `\nEarlier decisions need review: ${invalidated.join(', ')}` : ''}`,
          recovery: 'Choose explicitly. No import files change until every item is reviewed.',
        })
        if (agent || !isTTY()) {
          const suggested = decisionsPath ?? `${archivePath}.decisions.json`
          presentConflict({
            summary: 'Import requires an explicit decision for the next item.',
            details: JSON.stringify(decisionDocument(plan, choices, reviewed.issues, item, invalidated), null, 2),
            recovery: `Set choices[next.id] to "keep", "take", {"action":"add","address":"..."}, or {"action":"reuse","address":"..."} as applicable. Save the file and run woof import ${shellQuote(archivePath)} --decisions ${shellQuote(suggested)}${migration}${agent ? ' --agent' : ''}.`,
          })
          process.exitCode = 1
          return
        }
        const options = [
          ...(!item.requiredNewPath
            ? [
                { value: 'keep', label: 'Keep existing' },
                ...(item.incoming !== undefined ? [{ value: 'take', label: 'Take incoming' }] : []),
              ]
            : []),
          ...(item.incoming !== undefined && item.path !== '$metadata' ? [{ value: 'add', label: 'Add as new' }] : []),
          ...(item.candidates?.length && !item.requiredNewPath ? [{ value: 'reuse', label: 'Reuse existing' }] : []),
        ]
        const selected = await chooseOption({ message: `${item.path}: choose an action`, options })
        if (!selected) {
          process.exitCode = 130
          return
        }
        let choice: ImportChoice
        if (selected === 'keep' || selected === 'take') choice = selected
        else if (selected === 'add') {
          const address = await enterText(
            item.kind === 'token' || (item.kind === 'project-token' && item.path !== '$metadata')
              ? 'Enter an unused token address'
              : 'Enter an unused path under Woof home',
          )
          if (!address) {
            process.exitCode = 130
            return
          }
          choice = { action: 'add', address }
        } else if (selected === 'reuse') {
          const address = await chooseOption({
            message: 'Select the identical existing item',
            options: (item.candidates ?? []).map(value => ({ value, label: value })),
          })
          if (!address) {
            process.exitCode = 130
            return
          }
          choice = { action: 'reuse', address }
        } else throw new Error(`Unsupported import choice: ${selected}`)
        recorded = reviewed.issues
        choices[item.id] = choice
        try {
          reviewed = reviewImport(plan, choices)
        } catch (error) {
          delete choices[item.id]
          presentWarning(error instanceof Error ? error.message : String(error))
          reviewed = reviewImport(plan, choices)
          continue
        }
        const changed = Object.keys(choices).filter(id => {
          const before = recorded.find(entry => entry.id === id)
          const now = reviewed.issues.find(entry => entry.id === id)
          if (now?.invalid) return true
          if (id === item.id) return false
          return (
            !before ||
            !now ||
            before.path !== now.path ||
            before.existingDigest !== now.existingDigest ||
            before.incomingDigest !== now.incomingDigest
          )
        })
        for (const id of changed) {
          invalidated.push(recorded.find(entry => entry.id === id)?.path ?? id)
          delete choices[id]
        }
        if (changed.length) reviewed = reviewImport(plan, choices)
      }

      const result = applyImport(reviewed.candidate)
      let findings: string[]
      try {
        findings = validateImportedCatalog(cwd)
      } catch (error) {
        findings = [`Validation could not finish: ${error instanceof Error ? error.message : String(error)}`]
      }
      presentResult({
        summary: result.completed.length
          ? `Imported ${plan.bundle.projectName} without executing scripts.`
          : 'Import review passed; no files needed changes.',
        details: `${outcome(result)}${invalidated.length ? `\nRechecked decisions that no longer required a choice: ${invalidated.join(', ')}` : ''}`,
        recovery: findings.length
          ? 'Import completed. Review the separate validation findings; do not repeat the import.'
          : 'The imported catalog passed post-import validation.',
      })
      if (findings.length) {
        const configurationBroken = findings.some(finding =>
          /Could not parse configuration|Invalid configuration|Could not read configuration|requires an explicit \$schemaVersion|unsupported \$schemaVersion/.test(
            finding,
          ),
        )
        const recovery = configurationBroken
          ? 'Repair the configuration files named above before running Woof again.'
          : `Review the reported tokens or run woof validate --project ${shellQuote(plan.bundle.projectName)}.`
        presentWarning(`Import completed, but validation found:\n${findings.join('\n')}\n${recovery}`)
      }
    } catch (error) {
      presentError({
        summary: 'Woof could not complete the import.',
        details: `${error instanceof Error ? error.message : String(error)}${error instanceof ImportApplyError ? `\n${outcome(error.report)}` : ''}`,
        recovery:
          'Review the archive and destination state, then retry with explicit choices. Incomplete review changes nothing; retained recovery artifacts remain available when reported.',
      })
      process.exitCode = 1
    }
  },
})
