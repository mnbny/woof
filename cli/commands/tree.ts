import ansis from 'ansis'
import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseArgs } from 'node:util'

import { fieldsText, inlineCodeText } from '../utils/display.ts'
import { agentPresentation, chooseOption, presentCancel, presentCode, presentError } from '../utils/presentation.ts'
import { checkoutPath, loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { isTTY, terminalHasColor } from '../utils/terminal.ts'

type Tree = '...' | '###' | { [key: string]: Tree }

// Palette colors also work on terminals without true color.
const LEVEL_COLORS = ['#afd7ff', '#afffaf', '#ffd787', '#d7afff', '#ffafaf']

function renderTree(tree: Tree, color: boolean, prefix = '', depth = 0): string {
  if (typeof tree === 'string') return tree
  const entries = Object.entries(tree)
  return entries
    .map(([key, value], index) => {
      const last = index === entries.length - 1
      const paint = (text: string) => (color ? ansis.hex(LEVEL_COLORS[depth % LEVEL_COLORS.length]!)(text) : text)
      const label = paint(`${last ? '└─' : '├─'} ${key}`)
      const line = `${prefix}${label}${typeof value === 'string' ? `: ${value}` : ''}`
      const children =
        typeof value === 'string' ? '' : renderTree(value, color, `${prefix}${last ? '   ' : paint('│  ')}`, depth + 1)
      return children ? `${line}\n${children}` : line
    })
    .join('\n')
}

function abridge(value: unknown): Tree {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '...'
  if ('$type' in value) return value.$type === 'prompt' ? '...' : '###'
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '$schemaVersion' && key !== '$metadata')
      .map(([key, child]) => [key, abridge(child)]),
  )
}

function selectBranch(tree: Tree, path: string | undefined): Tree {
  if (path === undefined) return tree
  const parts = path.split('.')
  let branch = tree
  for (const part of parts) {
    if (typeof branch === 'string' || !Object.hasOwn(branch, part))
      throw new Error(`Path ${inlineCodeText(path)} does not exist in this tree.`)
    branch = branch[part]!
  }
  return parts.reduceRight<Tree>((child, key) => ({ [key]: child }), branch)
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    path: { description: 'Exact dotted branch or token path', type: 'positional', required: false },
    project: { description: 'Show definitions from one registered project', type: 'string' },
    repo: { description: 'Show only the current repository configuration', type: 'boolean' },
  },
  meta: { description: 'Show configuration structure without token content', name: 'tree' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          project: { type: 'string' },
          repo: { type: 'boolean' },
        },
      })
      if (positionals.length > 1) throw new Error('Tree accepts at most one path.')
      if (values.repo && values.project !== undefined) throw new Error('Choose --repo or --project, not both.')
      const path = positionals[0]
      const agent = agentPresentation()
      const cwd = process.cwd()
      const loader = createResourceLoader({ cwd })
      const root = loader.loadRootConfiguration()
      const projects = loadRegisteredProjects(root, loader)
      let projectName = values.project
      let projectReason = 'chosen for this command'
      let repository = values.repo === true

      if (!agent && isTTY() && path === undefined && projectName === undefined && !repository) {
        const context = selectProjectContext({ cwd, loader })
        const current = 'project' in context ? context.project : undefined
        const available = context.selection === 'ambiguous' ? context.candidates : projects
        const projectPath =
          current?.kind === 'repository' ? context.checkoutRoot : current ? checkoutPath(current) : undefined
        const scope = await chooseOption({
          message: 'Tree to show',
          options: [
            { value: 'full', label: 'Full tree', hint: root.source.file },
            ...(current || available.length
              ? [{ value: 'project', label: 'Project tree', ...(projectPath ? { hint: projectPath } : {}) }]
              : []),
          ],
        })
        if (!scope) return presentCancel('Tree cancelled.')
        if (scope === 'project') {
          if (current?.kind === 'repository') repository = true
          else if (current) {
            projectName = current.name
            projectReason = 'its paths match this directory'
          } else {
            projectName = await chooseOption({
              message: 'Project to show',
              options: available.map(project => {
                const path = checkoutPath(project)
                return { value: project.name, label: project.name, ...(path ? { hint: path } : {}) }
              }),
            })
            if (!projectName) return presentCancel('Tree cancelled.')
          }
        }
      }

      let tree: Tree
      const fields: [string, string][] = []
      if (repository) {
        const context = selectProjectContext({ cwd, loader })
        const project = 'project' in context ? context.project : undefined
        if (project?.kind !== 'repository') throw new Error('No repository configuration was found in this checkout.')
        tree = selectBranch(abridge(project.data), path)
        fields.push(
          ['Scope', 'project'],
          ['Project', `${basename(context.checkoutRoot!)} (repo config)`],
          ['Configuration', project.source.file],
        )
      } else if (projectName !== undefined) {
        const project = projects.find(project => project.name === projectName)
        if (!project) throw new Error(`Project ${inlineCodeText(projectName)} is not registered.`)
        tree = { $projects: { [projectName]: selectBranch(abridge(project.data), path) } }
        fields.push(['Scope', 'project'], ['Project', `${projectName} (${projectReason})`])
      } else {
        // Schema validation puts reserved fields first. Read their original positions without replacing the validated values.
        let source: Record<string, unknown>
        try {
          source = JSON.parse(readFileSync(root.source.file, 'utf8')) as Record<string, unknown>
        } catch {
          throw new Error(`Could not read configuration order at ${inlineCodeText(root.source.file)}.`)
        }
        const keys = [...new Set([...Object.keys(source), ...Object.keys(root.data)])].filter(key =>
          Object.hasOwn(root.data, key),
        )
        const configuration = Object.fromEntries(
          keys.map(key => [
            key,
            key === '$projects'
              ? Object.fromEntries(projects.map(project => [project.name, project.data]))
              : root.data[key],
          ]),
        )
        tree = selectBranch(abridge(configuration), path)
        fields.push(['Scope', 'shared tokens and registered projects'])
      }

      if (path !== undefined) fields.push(['Path', path])
      fields.push(['Prompt or alias', '...'], ['Script', '###'])
      const details = fieldsText(fields)
      const output = renderTree(tree, !agent && isTTY() && terminalHasColor()) || '(empty)'
      presentCode(`Configuration tree\n\n${details}`, output, {
        template: 'tree-result',
        values: { details, tree: output },
      })
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        { summary: 'woof could not show the tree.', details },
        { template: 'tree-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
