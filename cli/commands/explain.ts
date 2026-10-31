import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { shellQuote } from '../utils/display.ts'
import { chooseOption, presentError, presentResult, presentSelection } from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, explainToken, splitProjectAddress } from '../utils/tokens.ts'

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    project: { description: 'Select a registered project', type: 'string' },
    token: { description: 'Token address to explain', type: 'positional', required: true },
  },
  meta: { description: 'Explain a token resolution without executing it', name: 'explain' },
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
      if (positionals.length !== 1) throw new Error('Explain requires exactly one token address.')
      const query = positionals[0]!
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
            message: 'Select the project for this explanation',
            options: candidates.map(candidate => ({ value: candidate.name, label: candidate.name })),
          })
          if (!selected) {
            process.exitCode = 130
            return
          }
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          presentSelection({
            summary: 'Multiple projects match this explanation. Select one explicitly.',
            details: candidates
              .map(candidate => {
                const retry = `woof explain ${shellQuote(query)} --project ${shellQuote(candidate.name)}${agent ? ' --agent' : ''}`
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
      const explanation = explainToken(graph, query)
      const details = [
        `Selection: ${context.selection}`,
        `Project: ${context.project ? `${context.project.name ?? 'unnamed'} (${context.project.kind})` : 'Root only'}`,
        `Requested: ${explanation.requested}`,
        ...explanation.tokens.flatMap(token => {
          const value = graph.tokens.get(token.path)!.value
          const kind = typeof value === 'string' ? 'prompt' : value.$type
          const lines = [
            '',
            `${token.path} [${kind}; ${token.origin}]`,
            `  Source: ${token.source.file}`,
            `  Root: ${token.source.root}`,
          ]
          if (token.overridden) lines.push(`  Overrides: ${token.overridden.source.file}`)
          if (token.description !== undefined) lines.push(`  Description: ${token.description}`)
          if (token.tags !== undefined) lines.push(`  Tags: ${token.tags.join(', ')}`)
          if (token.references.length) lines.push(`  References: ${token.references.join(', ')}`)
          for (const file of token.files) lines.push(`  Resource: ${file.markedPath} -> ${file.file}`)
          return lines
        }),
      ].join('\n')

      presentResult({
        summary: `Resolution for ${explanation.requested}`,
        details,
        recovery: 'Explanation and preflight completed without executing any computed tokens.',
      })
    } catch (error) {
      presentError({
        summary: 'Woof could not explain the resolution.',
        details: error instanceof Error ? error.message : String(error),
        recovery:
          'Review the reported source chain, missing reference or cycle, then retry with an exact token address and project.',
      })
      process.exitCode = 1
    }
  },
})
