import type { editToken as editTokenType, TokenEdit, TokenLayer, TokenTarget } from '../utils/authoring.ts'

import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { copyScriptForOverride, describeToken, editToken, targetLabel, targetPath } from '../utils/authoring.ts'
import { discoverResources } from '../utils/discovery.ts'
import { fieldsText, hintText, inlineCodeText, markdownText, shellQuote } from '../utils/display.ts'
import { openBrowser, renderPreview, runEditor } from '../utils/editor.ts'
import {
  browserCountdown,
  chooseOption,
  chooseToken,
  enterText,
  presentCancel,
  presentCode,
  presentError,
  presentNotice,
  presentResult,
  presentSelection,
} from '../utils/presentation.ts'
import { selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'
import { createTokenGraph } from '../utils/tokens.ts'

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
    private: { description: 'Replace the token content with a private placeholder on export', type: 'boolean' },
    'no-private': { description: 'Include the token content in exports', type: 'boolean' },
    shared: { description: 'Change a shared token for every project', type: 'boolean' },
    override: { description: 'Override a shared token in the selected project', type: 'boolean' },
  },
  meta: { description: 'Edit the content, metadata, or export privacy of a token', name: 'edit' },
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
          private: { type: 'boolean' },
          'no-private': { type: 'boolean' },
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
      if (values.shared && values.override)
        throw new Error(`Choose ${inlineCodeText('--shared')} or ${inlineCodeText('--override')}, not both.`)

      let path = positionals[0]
      if (interactive) {
        const graph = createTokenGraph(
          selectProjectContext({ cwd, loader: createResourceLoader({ cwd }), ...(project ? { project } : {}) }),
        )
        if (path === undefined || !graph.tokens.has(path)) {
          path = await chooseToken({ message: 'Token to edit', tokens: discoverResources(graph), query: path ?? '' })
          if (!path) return presentCancel('Edit cancelled. Nothing was changed.')
        }
      }
      if (path === undefined) {
        presentSelection(
          {
            summary: 'Name the token to edit.',
            details: `Find it with woof get 'TERMS' --search${projectFlag}, then run woof edit 'PATH'${projectFlag}.`,
          },
          { template: 'edit-path', values: { project: projectFlag } },
        )
        process.exitCode = 1
        return
      }

      const token = describeToken(path, { cwd, project })
      if (values.override && !token.override)
        throw new Error(
          token.definition.kind === 'shared'
            ? `${inlineCodeText(path)} is a shared token, but no project is selected to hold an override. Run edit in a project, or pass ${inlineCodeText('--project NAME')}.`
            : `${inlineCodeText(path)} is a project token. Only a shared token can get an override.`,
        )
      const edit: TokenEdit = {
        ...(values.content !== undefined
          ? { content: values.content === '-' ? readFileSync(0, 'utf8').trimEnd() : values.content }
          : {}),
        ...(values.description !== undefined ? { description: values.description } : {}),
        ...(values.tag ? { tags: values.tag.map(tag => tag.trim()).filter(Boolean) } : {}),
        ...(values.private ? { private: true } : values['no-private'] ? { private: false } : {}),
      }
      const changes = Object.keys(edit).length > 0
      // A shared token seen from a project changes for all projects, or for this project only through an override.
      const layerChoices = token.override
        ? (
            [
              ['definition', '--shared', 'all projects (global)', { kind: 'shared' }],
              ['override', '--override', 'this project only (override)', token.override],
            ] as const
          ).map(([value, flag, label, target]) => {
            const path = targetPath(target, cwd)
            return { value, flag, label, ...(path ? { hint: path } : {}) }
          })
        : []
      let layer: TokenLayer | undefined = values.override
        ? 'override'
        : values.shared || !token.override
          ? 'definition'
          : undefined

      // An override of a script is a change by itself: it gives the project its own copy of the script files.
      const scriptOverride = !interactive && layer === 'override' && token.kind === 'fixed'
      if (!interactive && ((!changes && !scriptOverride) || !layer)) {
        const location =
          token.kind === 'inline'
            ? 'inline'
            : token.kind === 'file'
              ? token.files[0]!
              : `script files: ${token.files.join(', ') || 'none'}`
        const layers = token.override
          ? layerChoices
              .map(choice => `${choice.flag}  ${choice.label}${choice.hint ? `: ${choice.hint}` : ''}`)
              .join('\n')
          : `none needed: the token is defined in ${targetLabel(token.definition)}`
        const content = token.content ?? `The content is in ${token.files.join(', ')}.`
        const command = `woof edit ${shellQuote(path)}${projectFlag}${values.private ? ' --private' : values['no-private'] ? ' --no-private' : ''}${token.override && !layer ? ' LAYER' : ''} --description DESCRIPTION --tag TAG${
          token.kind === 'fixed' ? suffix : ` --content -${suffix} <<'WOOF'\nCONTENT\nWOOF`
        }`
        const description = token.description ?? 'none'
        const tags = token.tags.join(', ') || 'none'
        presentSelection(
          {
            summary: `Edit ${path}.`,
            details: `Type: ${token.type}\nDefined in: ${targetLabel(token.definition)}\nContent: ${location}\nDescription: ${description}\nTags: ${tags}\nPrivate: ${token.private ? 'yes' : 'no'}\n\n${content}\n\nLayers:\n${layers}\n\n${command}`,
            recovery: 'Pass only the fields that change.',
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
              private: token.private ? 'yes' : 'no',
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
          message: `Change ${inlineCodeText(path)} for`,
          options: layerChoices.map(({ value, label, hint }) => ({ value, label, ...(hint ? { hint } : {}) })),
        })
        if (!selected) return presentCancel('Edit cancelled. Nothing was changed.')
        layer = selected as TokenLayer
      }
      const target = layer === 'override' ? token.override! : token.definition
      const where = layerChoices.find(choice => choice.value === layer)?.label ?? targetLabel(target)
      // An override of a script gets its own copy of the files. The copy goes away if the edit does not finish.
      const copy =
        layer === 'override' && token.kind === 'fixed' ? copyScriptForOverride(path, { cwd, project }) : undefined
      const cancel = () => {
        copy?.remove()
        presentCancel('Edit cancelled. Nothing was changed.')
      }
      const save = async (changes: TokenEdit) => {
        try {
          const result = await editToken(
            path!,
            { ...changes, ...(copy ? { exec: copy.exec } : {}) },
            { cwd, project, layer, version: token.version },
          )
          report(path!, target, copy ? { ...result, contentFile: copy.files.join(', ') } : result, where)
        } catch (error) {
          copy?.remove()
          throw error
        }
      }

      if (changes || scriptOverride) return await save(edit)

      // The content comes first: a prompt in the browser page, a script in the editor of the person's choice. The
      // description and tags follow in the terminal, and woof writes everything once at the end.
      const editingPath = path
      const editingLayer = layer
      let content: string | undefined
      if (token.kind === 'fixed') {
        presentCode(
          `Edit ${inlineCodeText(path)} in an editor ${hintText('the content is a script file')}`,
          (copy?.files ?? token.files)
            .flatMap(file => EDITORS.map(editor => `${editor} ${shellQuote(file)}`))
            .join('\n'),
          null,
        )
      } else {
        const outcome = await runEditor<{ content: string }>(
          {
            state: () => ({
              path: editingPath,
              type: token.type,
              where,
              kind: token.kind,
              files: token.files,
              content: token.content ?? '',
            }),
            preview: text => renderPreview(text, token.type),
            save: async input => {
              const text = String(input['content'] ?? '')
              try {
                await markdownText(() =>
                  editToken(
                    editingPath,
                    { content: text },
                    { cwd, project, layer: editingLayer, version: token.version, check: true },
                  ),
                )
                return { saved: true, result: { content: text } }
              } catch (error) {
                return { saved: false, error: markdownText(() => message(error)) }
              }
            },
          },
          url => {
            presentCode(
              `Editing ${inlineCodeText(editingPath)} in browser ${hintText('If it does not open, visit this address. Press Ctrl+C to cancel.')}`,
              url,
              null,
            )
            const stop = browserCountdown(() => openBrowser(url))
            return outcome => stop(outcome === 'saved' ? 'Content saved in browser' : undefined)
          },
        )
        if (outcome.outcome !== 'saved') {
          presentNotice(
            {
              summary:
                outcome.outcome === 'expired'
                  ? 'The edit page closed after 30 minutes without activity. Nothing was changed.'
                  : 'Edit cancelled. Nothing was changed.',
            },
            null,
          )
          process.exitCode = outcome.outcome === 'expired' ? 1 : 130
          return
        }
        content = outcome.result.content
      }

      const description = await enterText(`Description ${hintText('optional')}`, {
        ...(token.description ? { initialValue: token.description } : {}),
        optional: true,
      })
      if (description === undefined) return cancel()
      const tags = await enterText(`Tags ${hintText('comma separated - optional')}`, {
        ...(token.tags.length ? { initialValue: token.tags.join(', ') } : {}),
        optional: true,
      })
      if (tags === undefined) return cancel()
      await save({
        ...(content !== undefined ? { content } : {}),
        description,
        tags: tags
          .split(',')
          .map(tag => tag.trim())
          .filter(Boolean),
      })
    } catch (error) {
      const details = message(error)
      presentError(
        {
          summary: 'woof could not edit the token.',
          details,
        },
        { template: 'edit-error', values: { details } },
      )
      process.exitCode = 1
    }

    function report(path: string, target: TokenTarget, result: EditResult, where: string) {
      if (!result.changed)
        return presentNotice(
          {
            summary: `No changes to ${inlineCodeText(path)}.`,
            details: 'The new values match the current token. Nothing was written.',
          },
          { template: 'edit-unchanged', values: { path } },
        )
      const project = target.kind === 'project' ? ` --project ${shellQuote(target.name)}` : ''
      const command = `woof get ${shellQuote(path)}${project}`
      const contentFile = result.contentFile ?? 'none'
      presentResult(
        {
          summary: `Edited ${inlineCodeText(path)}.`,
          details: fieldsText([
            ['Configuration', result.file],
            ['Content file', contentFile],
            ['Changed in', where],
          ]),
          recovery: `Check it with ${inlineCodeText(command)}.`,
        },
        {
          template: 'edit-result',
          values: { path, file: result.file, contentFile, where, command: `${command} --agent` },
        },
      )
    }
  },
})
