import type { ImportApplyReport } from '../utils/import-apply.ts'
import type { ImportChoice, ImportConflict } from '../utils/import-plan.ts'

import { defineCommand } from 'citty'
import { createPatch } from 'diff'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { diffText, hintText, inlineCodeText, listFieldText, mutedText, shellQuote } from '../utils/display.ts'
import { applyImport, ImportApplyError } from '../utils/import-apply.ts'
import { importReviewSources, planImport, reviewImport, verifyImportReviewSources } from '../utils/import-plan.ts'
import { getWoofHome } from '../utils/paths.ts'
import {
  chooseOption,
  enterText,
  presentCancel,
  presentCode,
  presentConflict,
  presentError,
  presentNotice,
  presentResult,
  presentWarning,
  renderTemplateFile,
} from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'
import { createTokenGraph, validateTokenGraph } from '../utils/tokens.ts'

function text(value: unknown) {
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`
}

function binaryText(value: Uint8Array) {
  return `Binary content: ${value.byteLength} bytes, SHA-256 ${createHash('sha256').update(value).digest('hex')}\n`
}

function reviewText(value: unknown) {
  if (value === undefined) return ''
  return value instanceof Uint8Array ? binaryText(value) : text(value)
}

// The diff shows the changed lines with their context. Its file header repeats the item, so it is left out. A missing
// side is empty, so an addition shows only added lines.
function patch(before: string, after: string) {
  return createPatch('', before, after, '', '', { context: 3 })
    .split('\n')
    .slice(4)
    .filter(line => !line.startsWith('\\ No newline'))
    .join('\n')
    .trimEnd()
}

const KIND_LABELS: Record<ImportConflict['kind'], string> = {
  token: 'shared token',
  'project-token': 'project token',
  file: 'file',
  project: 'project',
}

function reusableItems(item: ImportConflict): { address: string; description?: string }[] {
  return item.candidateDetails ?? (item.candidates ?? []).map(address => ({ address }))
}

function fileDiff(existing: Uint8Array | undefined, incoming: Uint8Array | undefined) {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return patch(
      existing === undefined ? '' : decoder.decode(existing),
      incoming === undefined ? '' : decoder.decode(incoming),
    )
  } catch {
    return [reviewText(existing), reviewText(incoming)].filter(Boolean).join('\n')
  }
}

// A token reads as its fields, then its content as text, so that a long prompt diffs line by line.
function tokenText(value: unknown) {
  if (value === undefined) return ''
  if (typeof value === 'string') return `${value}\n`
  if (!value || typeof value !== 'object' || !('$exec' in value)) return text(value)
  const token = value as { $type?: string; $exec: string | string[]; $description?: string; $tags?: string[] }
  return `${[
    ...(token.$type ? [`Type: ${token.$type}`] : []),
    ...(token.$description !== undefined ? [`Description: ${token.$description}`] : []),
    ...(token.$tags?.length ? [`Tags: ${token.$tags.join(', ')}`] : []),
    '',
    ...(Array.isArray(token.$exec) ? token.$exec : [token.$exec]),
  ].join('\n')}\n`
}

function conflictDiff(conflict: ImportConflict) {
  if (conflict.kind === 'file')
    return fileDiff(conflict.existing as Uint8Array | undefined, conflict.incoming as Uint8Array | undefined)
  if (conflict.kind === 'project') return patch(reviewText(conflict.existing), reviewText(conflict.incoming))
  return [
    patch(tokenText(conflict.existing), tokenText(conflict.incoming)),
    ...(conflict.files ?? []).map(file => `${file.reference}\n${fileDiff(file.existing, file.incoming)}`),
  ]
    .filter(Boolean)
    .join('\n\n')
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
    ...(item.keepTakeOnly ? { keepTakeOnly: true } : {}),
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
      renderTemplateFile('import-finding-unreadable', {
        file: getWoofHome('woof.config.json'),
        details: String(error),
      }),
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

function outcomeText(report: ImportApplyReport) {
  return [
    ...listFieldText('Completed', report.completed, 'Completed'),
    ...listFieldText('Restored', report.restored, 'Restored'),
    ...listFieldText('Pending', report.pending, 'Pending'),
    ...listFieldText('Recovery', report.recovery, 'Recovery'),
    ...listFieldText('Warning', report.warnings),
  ].join('\n')
}

function outcome(report: ImportApplyReport) {
  return renderTemplateFile('import-report', { fields: outcomeText(report) })
}

function presentBackup(backup: string | undefined) {
  if (!backup) return
  presentCode('Backup of woof home before this import', backup, {
    template: 'import-backup',
    values: { backup, backupArgument: shellQuote(backup), homeArgument: shellQuote(getWoofHome()) },
  })
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    archive: { description: 'Project ZIP archive to import', type: 'positional', required: true },
    decisions: { description: 'Reviewed import choices JSON', type: 'string' },
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
        },
      })
      if (positionals.length !== 1) throw new Error('Import requires exactly one ARCHIVE path.')
      const cwd = process.cwd()
      const archivePath = resolve(cwd, positionals[0]!)
      const decisionsPath = values.decisions ? resolve(cwd, values.decisions) : undefined
      const agent = values.agent === true || Boolean(isAgent())
      const archive = readFileSync(archivePath)

      const plan = planImport(archive, { cwd })
      const prior = decisionsPath ? readDecisions(decisionsPath, plan) : undefined
      const choices: Record<string, ImportChoice> = { ...(prior?.choices ?? {}) }
      let recorded = prior?.conflicts ?? []
      const invalidated: string[] = []
      // A decision that a later choice reopened goes back to the user, even for an item that is new here.
      const reopened = new Set<string>()
      let reviewed: ReturnType<typeof reviewImport>
      try {
        reviewed = reviewImport(plan, choices)
      } catch (error) {
        const id = prior?.next?.id
        if (!id || !choices[id]) throw error
        delete choices[id]
        reopened.add(id)
        invalidated.push(
          `${recorded.find(item => item.id === id)?.path ?? id}: ${error instanceof Error ? error.message : String(error)}`,
        )
        reviewed = reviewImport(plan, choices)
      }
      let freshlyChosen = prior?.next?.id
      for (;;) {
        const changed = Object.keys(choices).filter(id => {
          const before = recorded.find(item => item.id === id)
          const now = reviewed.issues.find(item => item.id === id)
          if (now?.invalid) return true
          if (id === freshlyChosen) return false
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
          reopened.add(id)
          delete choices[id]
        }
        reviewed = reviewImport(plan, choices)
        freshlyChosen = undefined
      }
      for (;;) {
        if (reviewed.status === 'ready') break
        const item = reviewed.next
        // Only a conflict needs a decision. An item that does not exist here yet is taken without a review, unless it
        // matches a local item that it could reuse, needs a new path, was reopened, or an earlier take of it failed.
        const added = item.existing === undefined && item.incoming !== undefined && !item.candidates?.length
        if ((added || item.derived) && !item.requiredNewPath && !reopened.has(item.id) && !item.invalid) {
          choices[item.id] = 'take'
          reviewed = reviewImport(plan, choices)
          continue
        }
        const diff = conflictDiff(item)
        const notice = item.notice ? `\n${item.notice}` : ''
        const reusable = item.candidates?.length
          ? `\n${renderTemplateFile('import-reusable', {
              candidates: reusableItems(item)
                .map(({ address, description }) =>
                  agent
                    ? `- ${address}${description ? `: ${description}` : ''}`
                    : `- ${inlineCodeText(address)}${description ? `  ${mutedText(description)}` : ''}`,
                )
                .join('\n'),
            })}`
          : ''
        const rechecks = invalidated.length
          ? `\n${renderTemplateFile('import-rechecks', { items: invalidated.join(', ') })}`
          : ''
        presentConflict(
          {
            summary: `Review ${KIND_LABELS[item.kind]} ${inlineCodeText(item.path)}`,
            details: diffText(diff),
            notes: `${notice}${reusable}${rechecks}`.trim(),
          },
          null,
        )
        if (agent || !isTTY()) {
          const suggested = decisionsPath ?? `${archivePath}.decisions.json`
          const document = JSON.stringify(decisionDocument(plan, choices, reviewed.issues, item, invalidated), null, 2)
          presentConflict(
            {
              summary: 'Import requires an explicit decision for the next item.',
              details: document,
              recovery: `Set choices[next.id] to "keep", "take", {"action":"add","address":"..."}, or {"action":"reuse","address":"..."} as applicable. Save the file and run woof import ${shellQuote(archivePath)} --decisions ${shellQuote(suggested)}${agent ? ' --agent' : ''}.`,
            },
            {
              template: 'import-decision',
              values: {
                kind: KIND_LABELS[item.kind],
                path: item.path,
                diff,
                notice,
                reusable,
                rechecks,
                document,
                archive: shellQuote(archivePath),
                decisions: shellQuote(suggested),
              },
            },
          )
          process.exitCode = 1
          return
        }
        // Taking the archive's version comes first, so it is the default.
        const local = item.existing !== undefined
        const file = item.kind === 'file' || item.kind === 'project'
        const options = [
          ...(!item.requiredNewPath && item.incoming !== undefined
            ? [
                {
                  value: 'take',
                  label: 'Take incoming',
                  hint: local ? "replace yours with the archive's version" : "import the archive's version",
                },
              ]
            : []),
          ...(!item.requiredNewPath
            ? [
                {
                  value: 'keep',
                  label: 'Keep existing',
                  hint: local ? "keep yours and skip the archive's version" : 'do not import it',
                },
              ]
            : []),
          ...((item.incoming !== undefined || item.requiredNewPath) && item.path !== '$metadata' && !item.keepTakeOnly
            ? [
                {
                  value: 'add',
                  label: 'Add as new',
                  hint: `import it at a new ${file ? 'path' : 'address'}${local ? ' and keep yours' : ''}`,
                },
              ]
            : []),
          ...(item.candidates?.length && !item.keepTakeOnly
            ? [
                {
                  value: 'reuse',
                  label: 'Reuse existing',
                  hint: `use your identical ${file ? 'file' : 'token'} instead of importing it`,
                },
              ]
            : []),
        ]
        const selected = await chooseOption({ message: `${inlineCodeText(item.path)}: choose an action`, options })
        if (!selected) return presentCancel('Import cancelled. Nothing was changed.')
        let choice: ImportChoice
        if (selected === 'keep' || selected === 'take') choice = selected
        else if (selected === 'add') {
          const address = await enterText(
            item.kind === 'token' || (item.kind === 'project-token' && item.path !== '$metadata')
              ? `Token address ${hintText('unused')}`
              : `Path under woof home ${hintText('unused')}`,
          )
          if (!address) return presentCancel('Import cancelled. Nothing was changed.')
          choice = { action: 'add', address }
        } else if (selected === 'reuse') {
          const address = await chooseOption({
            message: item.kind === 'file' ? 'File to reuse' : 'Token to reuse',
            options: reusableItems(item).map(({ address, description }) => ({
              value: address,
              label: address,
              ...(description ? { hint: description } : {}),
            })),
          })
          if (!address) return presentCancel('Import cancelled. Nothing was changed.')
          choice = { action: 'reuse', address }
        } else throw new Error(`Unsupported import choice: ${selected}`)
        recorded = reviewed.issues
        choices[item.id] = choice
        try {
          reviewed = reviewImport(plan, choices)
        } catch (error) {
          delete choices[item.id]
          presentWarning('import-choice-rejected', { details: error instanceof Error ? error.message : String(error) })
          reviewed = reviewImport(plan, choices)
          continue
        }
        let freshlySelected: string | undefined = item.id
        for (;;) {
          const changed = Object.keys(choices).filter(id => {
            const before = recorded.find(entry => entry.id === id)
            const now = reviewed.issues.find(entry => entry.id === id)
            if (now?.invalid) return true
            if (id === freshlySelected) return false
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
            invalidated.push(recorded.find(entry => entry.id === id)?.path ?? id)
            reopened.add(id)
            delete choices[id]
          }
          reviewed = reviewImport(plan, choices)
          freshlySelected = undefined
        }
      }

      const result = applyImport(reviewed.candidate)
      let findings: string[]
      try {
        findings = validateImportedCatalog(cwd)
      } catch (error) {
        findings = [
          renderTemplateFile('import-finding-incomplete', {
            details: error instanceof Error ? error.message : String(error),
          }),
        ]
      }
      const report = outcome(result)
      const rechecked = invalidated.length
        ? `\n${renderTemplateFile('import-rechecked', { items: invalidated.join(', ') })}`
        : ''
      const validation = findings.length ? renderTemplateFile('import-validation-findings') : ''

      // An import that changed nothing is a notice. Success reports a change.
      if (result.completed.length)
        presentResult(
          {
            summary: `Imported ${inlineCodeText(plan.bundle.projectName)}.`,
            details: `${outcomeText(result)}${rechecked}`,
            ...(validation ? { recovery: validation } : {}),
          },
          {
            template: 'import-imported',
            values: {
              project: plan.bundle.projectName,
              report,
              rechecked,
              validation: validation ? `\n\n${validation}` : '',
            },
          },
        )
      else
        presentNotice(
          { summary: 'Nothing was imported. Each item already matched or was kept.', details: rechecked.trim() },
          { template: 'import-unchanged', values: { rechecked } },
        )
      presentBackup(result.backup)
      if (findings.length) {
        const configurationBroken = findings.some(finding =>
          /Could not parse configuration|Invalid configuration|Could not read configuration|requires an explicit \$schemaVersion|unsupported \$schemaVersion/.test(
            finding,
          ),
        )
        presentWarning(configurationBroken ? 'import-findings-configuration' : 'import-findings', {
          findings: findings.join('\n'),
          project: shellQuote(plan.bundle.projectName),
        })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const report = error instanceof ImportApplyError ? `\n${outcome(error.report)}` : ''
      presentError(
        {
          summary: 'woof could not complete the import.',
          details: error instanceof ImportApplyError ? `${message}\n${outcomeText(error.report)}` : message,
          ...(error instanceof ImportApplyError ? { recovery: 'The report above lists what changed.' } : {}),
        },
        { template: 'import-error', values: { details: message, report } },
      )
      if (error instanceof ImportApplyError) presentBackup(error.report.backup)
      process.exitCode = 1
    }
  },
})
