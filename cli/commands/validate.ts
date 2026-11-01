import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { discoverResources } from '../utils/discovery.ts'
import { fieldsText, inlineCodeText, mutedText, shellQuote } from '../utils/display.ts'
import {
  chooseOption,
  chooseToken,
  presentCancel,
  presentError,
  presentResult,
  presentSelection,
} from '../utils/presentation.ts'
import { checkoutPath, selectedProjectText, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { createTokenGraph, preflightToken, preflightTokenGraph, splitProjectAddress } from '../utils/tokens.ts'

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
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
          project: { type: 'string' },
        },
      })
      if (positionals.length > 1) throw new Error('Validate accepts at most one token address.')
      let query = positionals[0] ?? ''
      const qualified = query.startsWith('$projects.') ? splitProjectAddress(query) : undefined
      if (qualified?.project && values.project && qualified.project !== values.project)
        throw new Error(
          `Qualified address selects ${inlineCodeText(qualified.project)}, which contradicts ${inlineCodeText(`--project ${values.project}`)}.`,
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
            message: 'Project to use',
            options: candidates.map(candidate => {
              const path = checkoutPath(candidate)
              return { value: candidate.name, label: candidate.name, ...(path ? { hint: path } : {}) }
            }),
          })
          if (!selected) return presentCancel('Validation cancelled.')
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          const details = candidates
            .map(candidate => {
              const path = checkoutPath(candidate)
              const name = `${agent ? '- ' : ''}${candidate.name}`
              return path ? `${name}  ${mutedText(path)}` : name
            })
            .join('\n')
          const command = `woof validate${query ? ` ${shellQuote(query)}` : ''} --project NAME${agent ? ' --agent' : ''}`
          presentSelection(
            {
              summary: 'Several projects match this directory.',
              details,
              recovery: `Retry with ${inlineCodeText(command)}, with NAME replaced by the project name.`,
            },
            { template: 'validate-ambiguous', values: { projects: details, command } },
          )
          process.exitCode = 1
          return
        }
      }

      const graph = createTokenGraph(context)
      if (query && !agent && process.stdout.isTTY && !graph.tokens.has(qualified?.path ?? query)) {
        const selected = await chooseToken({ message: 'Token to validate', tokens: discoverResources(graph), query })
        if (!selected) return presentCancel('Validation cancelled.')
        query = selected
      }
      const project = selectedProjectText(context) ?? 'none (shared tokens only)'
      const path = query ? splitProjectAddress(query).path : undefined
      // Unknown addresses are invocation errors, not problems in a stored token.
      if (path && !graph.tokens.has(path)) preflightToken(graph, query)
      const validation = preflightTokenGraph(graph, query ? [query] : [...graph.tokens.keys()])
      const problems = validation.problems
      if (problems.length) {
        const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`
        const details = problems.length === 1 ? problems[0]! : problems.map(problem => `- ${problem}`).join('\n')
        return fail(`woof found ${count}.`, details, problems.length === 1 ? 'it' : 'them')
      }
      if (path) {
        const references = validation.tokens.length - 1
        const referenced = references === 1 ? '1 referenced token' : `${references} referenced tokens`
        return valid(`${inlineCodeText(path)} is valid${references ? `, with ${referenced}` : ''}.`, project)
      }
      const count = graph.tokens.size
      valid(
        count === 0
          ? 'There are no tokens to validate.'
          : count === 1
            ? '1 token is valid.'
            : `All ${count} tokens are valid.`,
        project,
      )
    } catch (error) {
      fail('woof validation failed.', error instanceof Error ? error.message : String(error), 'it')
    }

    function valid(summary: string, project: string) {
      presentResult(
        { summary, details: fieldsText([['Project', project]]) },
        { template: 'validate-result', values: { summary, project } },
      )
    }

    function fail(summary: string, details: string, fix: string) {
      presentError(
        { summary, details, recovery: `Fix ${fix}, then run ${inlineCodeText('woof validate')} again.` },
        { template: 'validate-error', values: { summary, details, fix } },
      )
      process.exitCode = 1
    }
  },
})
