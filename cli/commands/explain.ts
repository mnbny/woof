import { defineCommand } from 'citty'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { discoverResources } from '../utils/discovery.ts'
import {
  fieldsText,
  inlineCodeText,
  listFieldText,
  mutedText,
  runtimeBadge,
  scopeBadge,
  shellQuote,
} from '../utils/display.ts'
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
import { secretBindingText } from '../utils/secrets.ts'
import { createTokenGraph, explainToken, splitProjectAddress } from '../utils/tokens.ts'

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    project: { description: 'Select a registered project', type: 'string' },
    token: { description: 'Token address to explain', type: 'positional', required: false },
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
      if (positionals.length > 1) throw new Error('Explain accepts one token address.')
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
          if (!selected) return presentCancel('Explanation cancelled.')
          context = selectProjectContext({ project: selected, loader: createResourceLoader({ cwd: process.cwd() }) })
        } else {
          const details = candidates
            .map(candidate => {
              const path = checkoutPath(candidate)
              const name = `${agent ? '- ' : ''}${candidate.name}`
              return path ? `${name}  ${mutedText(path)}` : name
            })
            .join('\n')
          const command = `woof explain ${shellQuote(query)} --project NAME${agent ? ' --agent' : ''}`
          presentSelection(
            {
              summary: 'Several projects match this directory.',
              details,
              recovery: `Retry with ${inlineCodeText(command)}, with NAME replaced by the project name.`,
            },
            { template: 'explain-ambiguous', values: { projects: details, command } },
          )
          process.exitCode = 1
          return
        }
      }

      const graph = createTokenGraph(context)
      if (!agent && process.stdout.isTTY && !graph.tokens.has(qualified?.path ?? query)) {
        const selected = await chooseToken({ message: 'Token to explain', tokens: discoverResources(graph), query })
        if (!selected) return presentCancel('Explanation cancelled.')
        query = selected
      }
      if (!query)
        throw new Error(`Name the token to explain. Find it with ${inlineCodeText("woof get 'TERMS' --search")}.`)
      const explanation = explainToken(graph, query)
      const project = selectedProjectText(context) ?? 'none (shared tokens only)'
      // The trace lists each token after its references, so the order starts again from the requested token.
      const traces = new Map(explanation.tokens.map(token => [token.path, token]))
      const ordered: typeof explanation.tokens = []
      const walk = (path: string) => {
        const token = traces.get(path)
        if (!token || ordered.includes(token)) return
        ordered.push(token)
        token.references.forEach(walk)
      }
      walk(explanation.requested)
      const tokens = ordered
        .map(token => {
          const value = graph.tokens.get(token.path)!.value
          const runtime = runtimeBadge(typeof value === 'string' ? 'prompt' : value.$type)
          const fields: [string, string][] = [['Source', token.source.file]]
          if (token.overridden) fields.push(['Overrides', token.overridden.source.file])
          if (token.description !== undefined) fields.push(['Description', token.description])
          if (token.tags !== undefined) fields.push(['Tags', token.tags.join(', ')])
          if (Object.keys(token.secrets).length) fields.push(['Secrets', secretBindingText(token.secrets)])
          return [
            `${inlineCodeText(token.path)} ${scopeBadge(token.origin)}${runtime ? ` ${runtime}` : ''}`,
            ...[
              ...fieldsText(fields).split('\n'),
              ...listFieldText('Reference', [...new Set(token.references)]),
              ...listFieldText('Deferred reference', [...new Set(token.deferred)]),
              ...listFieldText(
                'Resource',
                token.files.map(file => `${file.markedPath} -> ${file.file}`),
              ),
            ].map(line => `  ${line}`),
          ].join('\n')
        })
        .join(`\n\n${agent ? '↓' : ' ↓'}\n\n`)

      presentResult(
        {
          summary: `Resolution for ${inlineCodeText(explanation.requested)}`,
          details: `${fieldsText([['Project', project]])}\n\n${tokens}`,
        },
        { template: 'explain-result', values: { requested: explanation.requested, project, tokens } },
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'woof could not explain the resolution.',
          details,
          recovery: `Search the tokens with ${inlineCodeText('woof get')}.`,
        },
        { template: 'explain-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
