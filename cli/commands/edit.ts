import type { editToken as editTokenType, TokenEdit, TokenLayer, TokenTarget } from '../utils/authoring.ts'

import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { describeToken, editToken, targetLabel } from '../utils/authoring.ts'
import { shellQuote } from '../utils/display.ts'
import { openBrowser, renderPreview, runEditor } from '../utils/editor.ts'
import {
  chooseOption,
  presentCode,
  presentError,
  presentResult,
  presentSelection,
  searchOption,
} from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'
import { createTokenGraph, enumerateEffectiveTokens } from '../utils/tokens.ts'

type EditResult = Awaited<ReturnType<typeof editTokenType>>

const EDITORS = ['code', 'cursor', 'zed', 'subl', 'webstorm', 'vim', 'nano', 'emacs']

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    path: { description: 'Dotted path of the token to edit', type: 'positional', required: false },
    project: { description: 'Select a registered project', type: 'string' },
    content: { description: 'New content; - reads standard input', type: 'string' },
    description: { description: 'New description; an empty value removes it', type: 'string' },
    tag: { description: 'New tag set (repeatable); an empty value removes all tags', type: 'string' },
    shared: { description: 'Change a shared token for every project', type: 'boolean' },
    override: { description: 'Override a shared token in the selected project', type: 'boolean' },
  },
  meta: { description: 'Edit the content, description, or tags of a token', name: 'edit' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          project: { type: 'string' },
          content: { type: 'string' },
          description: { type: 'string' },
          tag: { type: 'string', multiple: true },
          shared: { type: 'boolean' },
          override: { type: 'boolean' },
        },
      })
      const agent = values.agent === true || Boolean(isAgent())
      const interactive = !agent && isTTY()
      const suffix = agent ? ' --agent' : ''
      const cwd = process.cwd()
      const project = values.project
      const projectFlag = project ? ` --project ${shellQuote(project)}` : ''
      if (values.shared && values.override) throw new Error('Choose --shared or --override, not both.')

      let path = positionals[0]
      if (path === undefined) {
        if (!interactive) {
          presentSelection(
            {
              summary: 'Name the token to edit.',
              details: `Find it with woof get 'TERMS' --search${projectFlag}, then run woof edit 'PATH'${projectFlag}.`,
              recovery: 'Nothing was changed.',
            },
            { template: 'edit-path', values: { project: projectFlag } },
          )
          process.exitCode = 1
          return
        }
        const context = selectProjectContext({
          cwd,
          loader: createResourceLoader({ cwd }),
          ...(project ? { project } : {}),
        })
        path = await searchOption({
          message: 'Token to edit',
          options: enumerateEffectiveTokens(createTokenGraph(context)).map(token => ({
            value: token.path,
            label: token.path,
            ...(token.description ? { hint: token.description } : {}),
          })),
        })
        if (!path) {
          process.exitCode = 130
          return
        }
      }

      const token = describeToken(path, { cwd, project })
      if (values.override && !token.override)
        throw new Error(`${path} is defined in ${targetLabel(token.definition)}, so it cannot get an override.`)
      const edit: TokenEdit = {
        ...(values.content !== undefined
          ? { content: values.content === '-' ? readFileSync(0, 'utf8').trimEnd() : values.content }
          : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.tag ? { tags: values.tag.map(tag => tag.trim()).filter(Boolean) } : {}),
      }
      const changes = Object.keys(edit).length > 0
      let layer: TokenLayer | undefined = values.override
        ? 'override'
        : values.shared || !token.override
          ? 'definition'
          : undefined

      if (!interactive && (!changes || !layer)) {
        const location =
          token.kind === 'inline'
            ? 'inline'
            : token.kind === 'file'
              ? token.files[0]!
              : `script files: ${token.files.join(', ') || 'none'}`
        const layers = token.override
          ? `--shared  change the shared token for every project\n--override  add an override in ${targetLabel(token.override)}`
          : `none needed: the token is defined in ${targetLabel(token.definition)}`
        const content = token.content ?? `The content is in ${token.files.join(', ')}.`
        const command = `woof edit ${shellQuote(path)}${projectFlag}${token.override && !layer ? ' LAYER' : ''} --description DESCRIPTION --tag TAG${
          token.kind === 'fixed' ? suffix : ` --content -${suffix} <<'WOOF'\nCONTENT\nWOOF`
        }`
        const description = token.description ?? 'none'
        const tags = token.tags.join(', ') || 'none'
        presentSelection(
          {
            summary: `Edit ${path}.`,
            details: `Type: ${token.type}\nDefined in: ${targetLabel(token.definition)}\nContent: ${location}\nDescription: ${description}\nTags: ${tags}\n\n${content}\n\nLayers:\n${layers}\n\n${command}`,
            recovery: 'Pass only the fields that change. Nothing was changed.',
          },
          {
            template: 'edit-draft',
            values: {
              path,
              type: token.type,
              where: targetLabel(token.definition),
              configuration: token.configuration,
              location,
              description,
              tags,
              content,
              layers,
              command,
            },
          },
        )
        process.exitCode = 1
        return
      }

      if (!layer) {
        const selected = await chooseOption({
          message: `${path} is a shared token. What should change?`,
          options: [
            { value: 'definition', label: 'The shared token', hint: 'every project sees the change' },
            { value: 'override', label: `An override in ${targetLabel(token.override!)}`, hint: 'only this project' },
          ],
        })
        if (!selected) {
          process.exitCode = 130
          return
        }
        layer = selected as TokenLayer
      }
      const target = layer === 'override' ? token.override! : token.definition

      if (changes) return report(path, target, await editToken(path, edit, { cwd, project, layer }))

      const editingPath = path
      const editingLayer = layer
      const outcome = await runEditor<EditResult>(
        {
          state: () => {
            const current = describeToken(editingPath, { cwd, project })
            return {
              path: editingPath,
              type: current.type,
              where: editingLayer === 'override' ? `new override in ${targetLabel(target)}` : targetLabel(target),
              description: current.description ?? '',
              tags: current.tags,
              kind: current.kind,
              files: current.files,
              editable: current.kind !== 'fixed',
              content: current.content ?? '',
              commands: current.files.flatMap(file => EDITORS.map(editor => `${editor} ${shellQuote(file)}`)),
              version: current.version,
            }
          },
          preview: content => renderPreview(content, token.type),
          save: async input => {
            try {
              const result = await editToken(
                editingPath,
                {
                  ...(typeof input['content'] === 'string' ? { content: input['content'] } : {}),
                  description: String(input['description'] ?? ''),
                  tags: Array.isArray(input['tags']) ? input['tags'].map(String) : [],
                },
                { cwd, project, layer: editingLayer, version: String(input['version']) },
              )
              return {
                saved: true,
                result: { ...result, summary: result.changed ? `Saved ${editingPath}.` : 'Nothing changed.' },
              }
            } catch (error) {
              return { saved: false, error: message(error) }
            }
          },
        },
        url => {
          presentCode(
            `Editing ${editingPath} in the browser. If it did not open, visit this address. Press Ctrl+C to cancel.`,
            url,
            null,
          )
          openBrowser(url)
        },
      )
      if (outcome.outcome === 'saved') return report(editingPath, target, outcome.result)
      presentError(
        {
          summary:
            outcome.outcome === 'expired'
              ? 'The edit page closed after 30 minutes without activity. Nothing was changed.'
              : 'Edit cancelled. Nothing was changed.',
        },
        null,
      )
      process.exitCode = outcome.outcome === 'expired' ? 1 : 130
    } catch (error) {
      const details = message(error)
      presentError(
        {
          summary: 'Woof could not edit the token.',
          details,
          recovery: 'Correct the reported problem, then retry. No configuration was changed.',
        },
        { template: 'edit-error', values: { details } },
      )
      process.exitCode = 1
    }

    function report(path: string, target: TokenTarget, result: EditResult) {
      if (!result.changed)
        return presentResult(
          {
            summary: `No changes to ${path}.`,
            details: 'The new values match the current token. Nothing was written.',
          },
          { template: 'edit-unchanged', values: { path } },
        )
      const project = target.kind === 'project' ? ` --project ${shellQuote(target.name)}` : ''
      const command = `woof get ${shellQuote(path)}${project}`
      const contentFile = result.contentFile ?? 'none'
      const where = targetLabel(target)
      presentResult(
        {
          summary: `Edited ${path}.`,
          details: `Configuration: ${result.file}\nContent file: ${contentFile}\nChanged in: ${where}`,
          recovery: `Check it with ${command}.`,
        },
        {
          template: 'edit-result',
          values: { path, file: result.file, contentFile, where, command: `${command} --agent` },
        },
      )
    }
  },
})
