import type { TokenContent, TokenDraft, TokenTarget, TokenType } from '../utils/authoring.ts'
import type { RegisteredProject } from '../utils/projects.ts'

import { defineCommand } from 'citty'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import {
  assertTokenPath,
  checkDraft,
  checkToken,
  readTokenContent,
  saveToken,
  targetLabel,
  TOKEN_TYPES,
} from '../utils/authoring.ts'
import { fieldsText, hintText, inlineCodeText, mutedText, shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'
import {
  chooseOption,
  enterMultiline,
  enterText,
  presentCancel,
  presentError,
  presentResult,
  presentSelection,
} from '../utils/presentation.ts'
import { checkoutPath, loadRegisteredProjects, selectProjectContext } from '../utils/projects.ts'
import { createResourceLoader } from '../utils/resources.ts'
import { isTTY } from '../utils/terminal.ts'
import { aliasTarget, createTokenGraph } from '../utils/tokens.ts'

const TYPE_HINTS: Record<TokenType, string> = {
  prompt: 'instructions or other text',
  bash: 'bash script',
  node: 'Node.js script',
  tsx: 'TypeScript script',
  bun: 'Bun script',
}

function targetKey(target: TokenTarget) {
  return target.kind === 'project' ? `project:${target.name}` : target.kind
}

function targetFlag(target: TokenTarget) {
  if (target.kind === 'shared') return '--shared'
  if (target.kind === 'repository') return '--repo'
  return `--project ${shellQuote(target.name)}`
}

type TargetChoice = { target: TokenTarget; label: string; hint?: string }

function targetChoice(target: TokenTarget, hint: string | undefined) {
  return { target, label: targetLabel(target), ...(hint ? { hint } : {}) }
}

function projectChoice(project: RegisteredProject) {
  return targetChoice({ kind: 'project', name: project.name }, checkoutPath(project))
}

function splitList(value: string) {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
}

function isTokenType(value: string): value is TokenType {
  return (TOKEN_TYPES as readonly string[]).includes(value)
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
    path: { description: 'Dotted token path, such as conventions.commit.default', type: 'positional', required: false },
    type: { description: `Token type: ${TOKEN_TYPES.join(', ')}`, type: 'string' },
    content: { description: 'Token content or a file path; - reads standard input', type: 'string' },
    description: { description: 'Description for discovery', type: 'string' },
    tag: { description: 'Tag for discovery (repeatable)', type: 'string' },
    private: { description: 'Replace the token content with a private placeholder on export', type: 'boolean' },
    shared: { description: 'Add the token to the shared tokens', type: 'boolean' },
    repo: { description: 'Add the token to the repository configuration', type: 'boolean' },
    project: { description: 'Add the token to this registered project', type: 'string' },
  },
  meta: { description: 'Add a token to shared or project configuration', name: 'add' },
  async run({ rawArgs }) {
    try {
      const { values, positionals } = parseArgs({
        args: rawArgs,
        allowPositionals: true,
        options: {
          agent: { type: 'boolean' },
          type: { type: 'string' },
          content: { type: 'string' },
          description: { type: 'string' },
          tag: { type: 'string', multiple: true },
          private: { type: 'boolean' },
          shared: { type: 'boolean' },
          repo: { type: 'boolean' },
          project: { type: 'string' },
        },
      })
      const agent = values.agent === true || Boolean(isAgent())
      const interactive = !agent && isTTY()
      const cwd = process.cwd()
      if ([values.shared, values.repo, values.project !== undefined].filter(Boolean).length > 1)
        throw new Error('Choose one of --shared, --repo or --project.')

      const loader = createResourceLoader({ cwd })
      const context = selectProjectContext({ cwd, loader })
      // A detected project narrows the targets to shared tokens and that project. Otherwise each project is a target.
      const choices: TargetChoice[] = [
        targetChoice({ kind: 'shared' }, getWoofHome('woof.config.json')),
        ...('project' in context && context.project
          ? [
              context.project.kind === 'repository'
                ? targetChoice({ kind: 'repository' }, context.checkoutRoot)
                : projectChoice(context.project),
            ]
          : (context.selection === 'ambiguous' ? context.candidates : loadRegisteredProjects(context.root, loader)).map(
              projectChoice,
            )),
      ]

      let target: TokenTarget | undefined = values.shared
        ? { kind: 'shared' }
        : values.repo
          ? { kind: 'repository' }
          : values.project !== undefined
            ? { kind: 'project', name: values.project }
            : choices.length === 1
              ? { kind: 'shared' }
              : undefined
      let path = positionals[0]
      let type = values.type
      let rawContent = values.content === '-' ? readFileSync(0, 'utf8').trimEnd() : values.content
      let description = values.description?.trim() || undefined
      let tags = values.tag ?? []

      if (!interactive) {
        const missing = [
          ...(path === undefined ? ['path'] : []),
          ...(type === undefined ? ['type'] : []),
          ...(rawContent === undefined ? ['content'] : []),
          ...(target === undefined ? ['target'] : []),
        ]
        if (missing.length) {
          const graph = createTokenGraph(context)
          const namespaces =
            [...new Set([...graph.rootNamespaces, ...graph.projectNamespaces])].sort().join('\n') || 'none'
          const targetList = choices
            .map(choice => `${targetFlag(choice.target)}  ${choice.label}${choice.hint ? `: ${choice.hint}` : ''}`)
            .join('\n')
          const command = [
            'woof add',
            path === undefined ? 'PATH' : shellQuote(path),
            '--type',
            type ?? 'TYPE',
            target ? targetFlag(target) : 'TARGET',
            ...(values.private ? ['--private'] : []),
            '--description',
            description === undefined ? 'DESCRIPTION' : shellQuote(description),
            ...(tags.length ? tags.flatMap(tag => ['--tag', shellQuote(tag)]) : ['--tag', 'TAG']),
            `--content -${agent ? ' --agent' : ''} <<'WOOF'\nCONTENT\nWOOF`,
          ].join(' ')
          presentSelection(
            {
              summary: `woof needs more input to add a token: ${missing.join(', ')}.`,
              details: `${command}\n\nTargets:\n${targetList}\n\nExisting namespaces:\n${namespaces}`,
              recovery: 'Retry with the complete command.',
            },
            {
              template: 'add-draft',
              values: { missing: missing.join(', '), namespaces, targets: targetList, command },
            },
          )
          process.exitCode = 1
          return
        }

        // Each reason that the command can find is reported at once, so one corrected call can succeed.
        const errors: string[] = []
        if (!isTokenType(type!)) errors.push(`The type must be one of: ${TOKEN_TYPES.join(', ')}.`)
        let content: TokenContent | undefined
        try {
          assertTokenPath(path!)
        } catch (error) {
          errors.push(message(error))
        }
        try {
          content = readTokenContent(rawContent!, { cwd, target: target!, path: path! })
        } catch (error) {
          errors.push(message(error))
        }
        if (!errors.length) {
          try {
            checkDraft(
              {
                target: target!,
                path: path!,
                type: type as TokenType,
                content: content!,
                description,
                tags,
                private: values.private,
              },
              cwd,
            )
          } catch (error) {
            errors.push(message(error))
          }
        }
        if (errors.length) throw new Error(errors.join('\n'))
        return await save({
          target: target!,
          path: path!,
          type: type as TokenType,
          content: content!,
          description,
          tags,
          private: values.private,
        })
      }

      const cancel = () => presentCancel('Add cancelled. Nothing was changed.')
      const retry = (error: unknown) => presentError({ summary: message(error) }, null)

      if (!target) {
        const selected = await chooseOption({
          message: 'Where should the token live?',
          options: choices.map(choice => ({
            value: targetKey(choice.target),
            label: choice.label,
            ...(choice.hint ? { hint: choice.hint } : {}),
          })),
        })
        if (!selected) return cancel()
        target = choices.find(choice => targetKey(choice.target) === selected)!.target
      }

      for (;;) {
        if (path === undefined) {
          path = await enterText(
            `Token path ${mutedText('(e.g.')} ${inlineCodeText('conventions.commit.default')}${mutedText(')')}`,
          )
          if (path === undefined) return cancel()
        }
        try {
          checkToken({ target, path, value: '' }, cwd)
          break
        } catch (error) {
          retry(error)
          path = undefined
        }
      }

      if (type === undefined || !isTokenType(type)) {
        const selected = await chooseOption({
          message: 'Token type',
          options: TOKEN_TYPES.map(value => ({ value, label: value, hint: TYPE_HINTS[value] })),
        })
        if (!selected) return cancel()
        type = selected
      }
      const tokenType = type as TokenType

      let content: TokenContent
      for (;;) {
        if (rawContent === undefined) {
          rawContent = await enterMultiline(`Content ${hintText('paste text or a file path')}`)
          if (rawContent === undefined) return cancel()
        }
        try {
          content = readTokenContent(rawContent, { cwd, target, path })
          checkDraft({ target, path, type: tokenType, content, description: undefined, tags: [] }, cwd)
          break
        } catch (error) {
          retry(error)
          rawContent = undefined
        }
      }

      if (values.description === undefined) {
        const entered = await enterText(`Description ${hintText('optional')}`, { optional: true })
        if (entered === undefined) return cancel()
        description = entered || undefined
      }
      if (!tags.length) {
        const entered = await enterText(`Tags ${hintText('comma separated - optional')}`, { optional: true })
        if (entered === undefined) return cancel()
        tags = splitList(entered)
      }

      await save({ target, path, type: tokenType, content, description, tags, private: values.private })
    } catch (error) {
      const details = message(error)
      presentError(
        {
          summary: 'woof could not add the token.',
          details,
        },
        { template: 'add-error', values: { details } },
      )
      process.exitCode = 1
    }

    async function save(draft: TokenDraft) {
      const { file, overrides } = await saveToken(draft, process.cwd())
      const content = draft.content.copy
        ? `${draft.content.exec} (copied from ${draft.content.file})`
        : draft.content.file
          ? draft.content.exec
          : 'inline'
      const description = draft.description ?? 'none'
      const tags = draft.tags.join(', ') || 'none'
      const override = overrides ? 'yes' : 'no'
      // Only a prompt without metadata is saved as a plain string, which is the form of an alias.
      const target =
        draft.type === 'prompt' &&
        !draft.content.file &&
        !draft.description &&
        !draft.tags.length &&
        draft.private === undefined
          ? aliasTarget(draft.content.exec)
          : undefined
      const type = target ? `alias of ${target}` : draft.type
      const project = draft.target.kind === 'project' ? ` --project ${shellQuote(draft.target.name)}` : ''
      const command = `woof get ${shellQuote(draft.path)}${project}`
      presentResult(
        {
          summary: `Added ${inlineCodeText(draft.path)}.`,
          details: fieldsText([
            ['Configuration', file],
            ['Type', type],
            ['Content', content],
            ['Description', description],
            ['Tags', tags],
            ['Private', draft.private ? 'yes' : 'no'],
            ['Overrides a shared token', override],
          ]),
          recovery: `Check it with ${inlineCodeText(command)}.`,
        },
        {
          template: 'add-result',
          values: {
            path: draft.path,
            file,
            type,
            content,
            description,
            tags,
            private: draft.private ? 'yes' : 'no',
            override,
            command: `${command} --agent`,
          },
        },
      )
    }
  },
})
