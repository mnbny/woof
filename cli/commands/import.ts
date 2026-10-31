import type { ImportApplyReport } from '../utils/import-apply.ts'
import type { ImportChoice, ImportConflict } from '../utils/import-plan.ts'

import { defineCommand } from 'citty'
import { createPatch } from 'diff'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { BUNDLE_LIMITS } from '../utils/bundles.ts'
import { shellQuote } from '../utils/display.ts'
import { applyImport, ImportApplyError } from '../utils/import-apply.ts'
import { planImport, reviewImport } from '../utils/import-plan.ts'
import { chooseOption, presentConflict, presentError, presentResult } from '../utils/presentation.ts'
import { detectCheckoutRoot } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'

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

function decisionDocument(
  plan: ReturnType<typeof planImport>,
  choices: Readonly<Record<string, ImportChoice>>,
  next?: ImportConflict,
) {
  return {
    archive: plan.archiveDigest,
    choices: { ...choices },
    next: next
      ? {
          id: next.id,
          kind: next.kind,
          path: next.path,
          existingDigest: next.existingDigest,
          incomingDigest: next.incomingDigest,
        }
      : undefined,
    conflicts: plan.conflicts.map(conflict => ({
      id: conflict.id,
      kind: conflict.kind,
      path: conflict.path,
      existingDigest: conflict.existingDigest,
      incomingDigest: conflict.incomingDigest,
    })),
  }
}

function readDecisions(file: string, plan: ReturnType<typeof planImport>) {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Decisions must be a JSON object.')
  const document = value as Record<string, unknown>
  if (document['archive'] !== plan.archiveDigest)
    throw new Error('Decisions belong to a different archive; review this archive again.')
  if (!Array.isArray(document['conflicts'])) throw new Error('Decisions are missing reviewed conflict metadata.')
  const reviewed = document['conflicts']
  if (reviewed.length !== plan.conflicts.length)
    throw new Error('Decisions contain a different conflict set; review this archive again.')
  for (let index = 0; index < plan.conflicts.length; index += 1) {
    const expected = plan.conflicts[index]!
    const actual: unknown = reviewed[index]
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      throw new Error('Reviewed conflict entries must be objects.')
    const entry = actual as Record<string, unknown>
    if (
      entry['id'] !== expected.id ||
      entry['kind'] !== expected.kind ||
      entry['path'] !== expected.path ||
      entry['existingDigest'] !== expected.existingDigest ||
      entry['incomingDigest'] !== expected.incomingDigest
    )
      throw new Error(`Reviewed conflict ${expected.path} is stale; review this archive again.`)
  }
  const choices = document['choices']
  if (!choices || typeof choices !== 'object' || Array.isArray(choices))
    throw new Error('Decisions require a choices object containing keep/take values.')
  for (const choice of Object.values(choices))
    if (choice !== 'keep' && choice !== 'take') throw new Error('Every import choice must be keep or take.')
  return choices as Record<string, ImportChoice>
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
      if (statSync(archivePath).size > BUNDLE_LIMITS.archiveBytes)
        throw new Error(`Archive exceeds the ${BUNDLE_LIMITS.archiveBytes}-byte input limit.`)
      const archive = readFileSync(archivePath)
      assertImportContext(cwd)

      const plan = planImport(archive, { cwd })
      let choices: Record<string, ImportChoice> = {}
      if (decisionsPath) choices = readDecisions(decisionsPath, plan)
      for (const conflict of plan.conflicts) {
        if (decisionsPath) break
        presentConflict({
          summary: `Review ${conflict.kind} ${conflict.path} (${plan.conflicts.indexOf(conflict) + 1}/${plan.conflicts.length})`,
          details: conflictDiff(conflict),
          recovery: 'Choose keep-existing or take-incoming. No files change until every conflict is resolved.',
        })
        if (agent || !isTTY()) {
          const suggested = decisionsPath ?? `${archivePath}.decisions.json`
          presentConflict({
            summary:
              'Import requires an explicit decisions handoff; add keep-existing or take-incoming for the next conflict.',
            details: JSON.stringify(decisionDocument(plan, choices, conflict), null, 2),
            recovery: `Save the reviewed choices and run woof import ${shellQuote(archivePath)} --decisions ${shellQuote(suggested)}${migration}${agent ? ' --agent' : ''}.`,
          })
          process.exitCode = 1
          return
        }
        const selected = await chooseOption({
          message: `${conflict.path}: choose the value to retain`,
          options: [
            { value: 'keep', label: 'Keep existing' },
            { value: 'take', label: 'Take incoming' },
          ],
        })
        if (!selected) {
          process.exitCode = 130
          return
        }
        if (selected !== 'keep' && selected !== 'take') throw new Error(`Unsupported import choice: ${selected}`)
        choices[conflict.id] = selected
      }

      const reviewed = reviewImport(plan, choices)
      if (reviewed.status === 'incomplete') {
        presentConflict({
          summary: `Import review is incomplete; ${reviewed.remaining} conflict(s) remain.`,
          details: `${conflictDiff(reviewed.next)}\n${JSON.stringify(decisionDocument(plan, choices, reviewed.next), null, 2)}`,
          recovery: `Complete every choice and rerun woof import ${shellQuote(archivePath)}${decisionsPath ? ` --decisions ${shellQuote(decisionsPath)}` : ''}${migration}${agent ? ' --agent' : ''}. No import was applied.`,
        })
        process.exitCode = 1
        return
      }

      const result = applyImport(reviewed.candidate)
      const deferred = [
        ...result.deferredRequirements,
        ...result.deferredProjects.map(name => `project configuration ${name}`),
      ]
      presentResult({
        summary: result.completed.length
          ? `Imported ${plan.bundle.projectName} without executing scripts.`
          : 'Import review passed; no files needed changes.',
        details: outcome(result),
        recovery: deferred.length
          ? `Checkout resources require normal validation in the target checkout: woof validate --project ${shellQuote(plan.bundle.projectName)}. Deferred: ${deferred.join(', ')}`
          : 'All selected configuration and resources passed final validation before application.',
      })
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
