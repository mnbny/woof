import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { shellQuote } from '../utils/display.ts'
import { chooseOption, presentError, presentResult, presentSelection } from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, splitProjectAddress, validateTokenGraph } from '../utils/tokens.ts'

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    migrate: { description: 'Migrate supported legacy configuration explicitly', type: 'boolean' },
    project: { description: 'Select a registered project', type: 'string' },
    token: { description: 'Optional token graph to validate', type: 'positional', required: false },
  },
  meta: { description: 'Validate token catalogs without executing scripts', name: 'validate' },
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
      if (positionals.length > 1) throw new Error('Validate accepts at most one token address.')
      const query = positionals[0] ?? ''
      const qualified = query.startsWith('$projects.') ? splitProjectAddress(query) : undefined
      if (qualified?.project && values.project && qualified.project !== values.project)
        throw new Error(
          `Qualified address selects ${qualified.project}, which contradicts --project ${values.project}.`,
        )
      const explicitProject = qualified?.project ?? values.project
      const agent = values.agent === true || Boolean(isAgent())

      let context = selectProjectContext({
        ...(explicitProject ? { project: explicitProject } : {}),
        loader: createResourceLoader({ cwd: process.cwd() }),
      })
      if (context.selection === 'ambiguous') {
        const candidates = context.candidates
        if (!agent && process.stdout.isTTY) {
          const selected = await chooseOption({
            message: 'Select the project for validation',
            options: candidates.map(candidate => ({ value: candidate.name, label: candidate.name })),
          })
          if (!selected) {
            process.exitCode = 130
            return
          }
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          presentSelection({
            summary: 'Multiple projects match this validation. Select one explicitly.',
            details: candidates
              .map(candidate => {
                const retry = `woof validate${query ? ` ${shellQuote(query)}` : ''} --project ${shellQuote(candidate.name)}${agent ? ' --agent' : ''}`
                return `${candidate.name}\n  ${retry}`
              })
              .join('\n'),
            recovery: 'Retry with one exact --project value. No selection was persisted.',
          })
          process.exitCode = 1
          return
        }
      }

      const graph = createTokenGraph(context)
      const validations = validateTokenGraph(graph, query || undefined)
      const inspected = validations.reduce((total, validation) => total + validation.tokens.length, 0)
      const project = context.project ? `${context.project.name ?? 'unnamed'} (${context.project.kind})` : 'Root only'
      presentResult({
        summary: `Validated ${inspected} token definition${inspected === 1 ? '' : 's'} without executing scripts.`,
        details: [
          `Selection: ${context.selection}`,
          `Project: ${project}`,
          `Scope: ${query || 'Complete effective catalog'}`,
        ].join('\n'),
        recovery: 'Configuration, references and declared resource paths passed preflight without computed execution.',
      })
    } catch (error) {
      presentError({
        summary: 'Woof validation failed.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Review the reported data, source or reference failure. Correct it or use --migrate for a supported legacy configuration, then retry.',
      })
      process.exitCode = 1
    }
  },
})
