import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

async function config(home: string, value: unknown) {
  await put(join(home, 'woof.config.json'), JSON.stringify(value))
}

type Cli = {
  entry: string
  project: string
  run(
    file: string,
    args: string[],
    cwd?: string,
    markers?: NodeJS.ProcessEnv,
    timeout?: number,
  ): Promise<{ status: number; stdout: string; stderr: string }>
}

function run(cli: Cli, home: string, args: string[]) {
  return cli.run(process.execPath, [cli.entry, ...args], cli.project, {
    WOOF_HOME: home,
    NO_COLOR: '1',
    TERM: 'dumb',
  })
}

test('renders deferred instructions without loading targets and preserves project context', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'deferred-home')
  const effect = join(directory, 'deferred-script-ran')
  await config(home, {
    $schemaVersion: 2,
    plain: 'inline',
    caller: '<root>/caller.txt',
    helper: '<root>/missing.txt',
    script: {
      $type: 'node',
      $exec: `require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran'); process.stdout.write('{{~helper~}}')`,
    },
    private: { $type: 'prompt', $exec: '{{-woof:private-}}', $private: true },
    malformed: '{{~unfinished{{~helper~}}',
    guarded: '${{~helper~}} {{{~helper~}}} {{~ helper ~}} {{~missing}}',
    deferredOnly: '{{~helper~}}',
    $projects: { demo: { helper: 'project helper', $metadata: { $basePaths: [cli.project] } } },
  })
  await put(
    join(home, 'caller.txt'),
    '{{plain}}; if needed, {{~helper~}}. use woof token {{~script~}}; `{{~private~}}`; {{{{~helper~}}}}',
  )
  const instruction = (path: string) => `use the woof token \`${path}\``
  const expected = (prefix = '') =>
    `inline; if needed, ${instruction(prefix + 'helper')}. use woof token ${instruction(prefix + 'script')}; \`${instruction(prefix + 'private')}\`; {{~helper~}}`
  const outside = await cli.run(process.execPath, [cli.entry, 'get', 'caller', '--agent'], directory, {
    WOOF_HOME: home,
  })
  expect(outside).toMatchObject({ status: 0, stdout: expected() })
  expect(outside.stderr).not.toContain('needs a value')
  for (const flags of [[], ['--project', 'demo'], ['--project', 'demo', '--agent']]) {
    const result = await run(cli, home, ['get', 'caller', ...flags])
    expect(result).toMatchObject({ status: 0, stdout: expected('$projects.demo.') })
    expect(result.stderr).not.toContain('needs a value')
  }
  expect(
    await cli.run(process.execPath, [cli.entry, 'get', '$projects.demo.helper', '--agent'], directory, {
      WOOF_HOME: home,
    }),
  ).toMatchObject({ status: 0, stdout: 'project helper' })
  expect(await run(cli, home, ['get', 'malformed', '--agent'])).toMatchObject({
    status: 0,
    stdout: '{{~unfinished' + instruction('$projects.demo.helper'),
  })
  expect(await run(cli, home, ['get', 'guarded', '--agent'])).toMatchObject({
    status: 0,
    stdout: '${{~helper~}} {{{~helper~}}} {{~ helper ~}} {{~missing}}',
  })
  const explain = await run(cli, home, ['explain', 'caller', '--agent'])
  expect(explain.status).toBe(0)
  expect(explain.stdout).toContain('Deferred references: helper, script, private')
  expect(explain.stdout).not.toContain('missing.txt')
  expect(explain.stderr).not.toContain('needs a value')
  const discovery = await run(cli, home, ['get', 'deferredOnly', '--search', '--agent'])
  expect(discovery.stdout).not.toContain('alias of')
  expect(existsSync(effect)).toBe(false)
  expect(await run(cli, home, ['get', 'script', '--agent'])).toMatchObject({ status: 0, stdout: '{{~helper~}}' })
  expect(existsSync(effect)).toBe(true)
})

test('validates deferred dependency chains while allowing deferred cycles and checking targets before effects', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'deferred-validation-home')
  const effect = join(directory, 'must-not-run')
  await config(home, {
    $schemaVersion: 2,
    start: '{{immediate}} {{~brokenFile~}} {{~brokenScript~}} {{~brokenChain~}}',
    immediate: '{{~start~}}',
    brokenFile: '<root>/missing.txt',
    brokenScript: { $type: 'node', $exec: '<root>/missing.js' },
    brokenChain: '{{absent}}',
    effect: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran')` },
    invalid: '{{effect}} {{~absent~}}',
    namespace: { token: 'text' },
    invalidNamespace: '{{~namespace~}}',
    invalidShared: '{{~onlyProject~}}',
    valid: '{{next}}',
    next: '{{~valid~}} {{~next~}} {{~effect~}}',
    badCycle: '{{~cycle~}}',
    cycle: '{{cycle}}',
    $projects: { demo: { onlyProject: 'local' } },
  })
  expect((await run(cli, home, ['get', 'start', '--agent'])).status).toBe(0)
  expect((await run(cli, home, ['explain', 'start', '--agent'])).status).toBe(0)
  const validation = await run(cli, home, ['validate', 'start', '--agent'])
  expect(validation.status).toBe(1)
  for (const target of ['brokenFile', 'brokenScript', 'brokenChain'])
    expect(validation.stdout).toContain(`start ~> ${target}`)
  expect(validation.stdout).toContain('missing.txt')
  expect(validation.stdout).toContain('missing.js')
  expect(validation.stdout).toContain('absent')
  expect(validation.stdout).not.toContain('Circular token reference')
  expect((await run(cli, home, ['validate', 'valid', '--agent'])).status).toBe(0)
  expect((await run(cli, home, ['validate', 'badCycle', '--agent'])).stdout).toContain('Circular token reference')
  for (const path of ['invalid', 'invalidNamespace', 'invalidShared']) {
    const result = await run(cli, home, ['get', path, '--project', 'demo', '--agent'])
    expect(result.status).toBe(1)
  }
  expect(existsSync(effect)).toBe(false)
  expect((await run(cli, home, ['edit', 'start', '--content', 'Updated {{~brokenFile~}}', '--agent'])).status).toBe(0)
  expect(
    (
      await run(cli, home, [
        'add',
        'newCaller',
        '--content',
        '{{~brokenScript~}}',
        '--type',
        'prompt',
        '--shared',
        '--agent',
      ])
    ).status,
  ).toBe(0)
})

test('reports each underlying validation failure once across immediate and deferred paths', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'validation-count-home')
  await config(home, {
    $schemaVersion: 2,
    fileChain: '{{middle}}',
    middle: '{{brokenFile}}',
    brokenFile: '<root>/missing.txt',
    both: '{{middle}} {{~brokenFile~}}',
    cycleChain: '{{a}}',
    a: '{{b}}',
    b: '{{a}}',
    branches: '{{middle}} {{brokenReference}}',
    brokenReference: '{{absent}}',
  })
  for (const path of ['fileChain', 'both', 'cycleChain']) {
    const result = await run(cli, home, ['validate', path, '--agent'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('woof found 1 problem.')
    const problem = path === 'cycleChain' ? /Circular token reference/g : /cannot load/g
    expect(result.stdout.match(problem)).toHaveLength(1)
  }
  const branches = await run(cli, home, ['validate', 'branches', '--agent'])
  expect(branches.status).toBe(1)
  expect(branches.stdout).toContain('woof found 2 problems.')
  expect(branches.stdout).toContain('missing.txt')
  expect(branches.stdout).toContain('absent')
})

test('applies project overrides after merging while preserving inherited lookup', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  await config(home, {
    $schemaVersion: 2,
    conventions: { commit: 'base', tests: 'meaningful' },
    agents: '{{conventions.commit}} {{conventions.tests}}',
    $projects: {
      microsoft: { conventions: { commit: 'semantic' } },
      acme: { agents: '{{conventions.commit}} Never touch legacy/.' },
    },
  })

  expect(await run(cli, home, ['get', 'agents', '--project', 'microsoft'])).toMatchObject({
    status: 0,
    stdout: 'semantic meaningful',
  })
  expect(await run(cli, home, ['get', 'conventions.tests', '--project', 'microsoft'])).toMatchObject({
    status: 0,
    stdout: 'meaningful',
  })
  expect(await run(cli, home, ['get', 'agents', '--project', 'acme'])).toMatchObject({
    status: 0,
    stdout: 'base Never touch legacy/.',
  })
  expect(await run(cli, home, ['get', '$projects.microsoft.agents'])).toMatchObject({
    status: 0,
    stdout: 'semantic meaningful',
  })
})

test('rejects global dependencies, self-cycles and missing references before script effects', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const marker = join(cli.project, 'computed-ran')
  await config(home, {
    $schemaVersion: 2,
    globalPrompt: '{{computed}} {{projectOnly}}',
    cyclePrompt: '{{computed}} {{cycleNext}}',
    cycleNext: '{{cyclePrompt}}',
    selfCycle: '{{computed}} {{selfCycle}}',
    missingPrompt: '{{computed}} {{absent}}',
    computed: { $type: 'node', $exec: `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')` },
    $projects: {
      demo: { projectOnly: 'project value', selfCycle: '{{computed}} {{selfCycle}}' },
    },
  })

  const validation = await run(cli, home, ['validate', 'computed'])
  expect(validation.status).toBe(0)
  expect(existsSync(marker)).toBe(false)

  const globalFailure = await run(cli, home, ['get', 'globalPrompt', '--project', 'demo'])
  expect(globalFailure.status).toBe(1)
  expect(globalFailure.stdout).toContain('depends on project-only token')
  expect(existsSync(marker)).toBe(false)

  const cycleFailure = await run(cli, home, ['get', 'cyclePrompt', '--project', 'demo'])
  expect(cycleFailure.status).toBe(1)
  expect(cycleFailure.stdout).toContain('Circular token reference')
  expect(existsSync(marker)).toBe(false)

  const selfCycleFailure = await run(cli, home, ['get', 'selfCycle', '--project', 'demo'])
  expect(selfCycleFailure.status).toBe(1)
  expect(selfCycleFailure.stdout).toContain('Circular token reference')
  expect(existsSync(marker)).toBe(false)

  const missingFailure = await run(cli, home, ['get', 'missingPrompt'])
  expect(missingFailure.status).toBe(1)
  expect(missingFailure.stdout).toMatch(/Token\s+absent\s+does not exist/)
  expect(existsSync(marker)).toBe(false)

  const cycleValidation = await run(cli, home, ['validate', 'cyclePrompt', '--project', 'demo'])
  expect(cycleValidation.status).toBe(1)
  expect(cycleValidation.stdout).toContain('Circular token reference')
  expect(existsSync(marker)).toBe(false)
})

test('keeps discovery metadata-only and reuses one literal computed result per resolution', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const counter = join(cli.project, 'counter')
  await config(home, {
    $schemaVersion: 2,
    conventions: { commit: 'literal' },
    computed: {
      $type: 'node',
      $exec: `require('fs').appendFileSync(${JSON.stringify(counter)}, 'run\\n'); process.stdout.write('{{conventions.commit}}')`,
      $description: 'Computed verification',
      $tags: ['verification'],
    },
    twice: '{{computed}} + {{computed}}',
  })

  const discovered = await run(cli, home, ['get', 'computed', '--search'])
  expect(discovered.status).toBe(0)
  expect(discovered.stdout).toContain('Computed verification')
  expect(discovered.stdout).toContain("woof get 'PATH'")
  expect(existsSync(counter)).toBe(false)

  const resolved = await run(cli, home, ['get', 'twice'])
  expect(resolved).toMatchObject({ status: 0, stdout: '{{conventions.commit}} + {{conventions.commit}}' })
  expect(await readFile(counter, 'utf8')).toBe('run\n')
})

test('lists project matches first while keeping relevance within each scope', async ({ cli, directory, expect }) => {
  const home = join(directory, 'discovery-home')
  await config(home, {
    $schemaVersion: 2,
    aShared: {
      $type: 'prompt',
      $exec: 'Shared notes',
      $description: 'Device verification notes for archived hardware',
    },
    zShared: { $type: 'prompt', $exec: 'Shared checks', $description: 'Device verification' },
    $projects: {
      demo: {
        aProject: {
          $type: 'prompt',
          $exec: 'Project notes',
          $description: 'Device verification guidance for legacy devices',
        },
        zProject: { $type: 'prompt', $exec: 'Project checks', $description: 'Device verification' },
      },
    },
  })

  for (const search of [false, true]) {
    const result = await run(cli, home, [
      'get',
      'device verification',
      '--project',
      'demo',
      '--agent',
      ...(search ? ['--search'] : []),
    ])
    expect(result.status).toBe(search ? 0 : 1)
    const paths = [...result.stdout.matchAll(/^- (\S+)/gm)].map(match => match[1])
    expect(paths).toEqual(['zProject', 'aProject', 'zShared', 'aShared'])
  }
})

test('finds single-word matches in any field without metadata dilution or duplicate tokens', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'single-word-home')
  await config(home, {
    $schemaVersion: 2,
    deploy: { $type: 'prompt', $exec: 'Shared deployment', $description: 'Deploy', $tags: ['deploy'] },
    'deploy-prod': { $type: 'prompt', $exec: 'Production', $description: 'Deploy to production' },
    $projects: {
      demo: {
        deploy: 'Project deployment',
        release: {
          'deploy-checklist': {
            $type: 'prompt',
            $exec: 'Checklist',
            $description: 'Steps before shipping',
            $tags: ['ops'],
          },
        },
        releaseAlias: '{{release.deploy-checklist}}',
        describe: { $type: 'prompt', $exec: 'Instructions', $description: 'deploy' },
        tagged: { $type: 'prompt', $exec: 'Instructions', $tags: ['deploy'] },
        several: { $type: 'prompt', $exec: 'Instructions', $description: 'deploy', $tags: ['deploy'] },
        bodyOnly: 'deploy',
        dep: { $type: 'prompt', $exec: 'Instructions', $description: 'loy' },
      },
    },
  })

  for (const search of [false, true]) {
    const result = await run(cli, home, [
      'get',
      search ? 'deploy' : 'deplo',
      '--project',
      'demo',
      '--agent',
      ...(search ? ['--search'] : []),
    ])
    expect(result.status).toBe(search ? 0 : 1)
    const paths = [...result.stdout.matchAll(/^- (\S+)/gm)].map(match => match[1])
    expect(paths).toEqual([
      'deploy',
      'describe',
      'tagged',
      'several',
      'release.deploy-checklist',
      'releaseAlias',
      'deploy-prod',
    ])
  }
})

test('matches every query word across fields with spaces, tabs or newlines', async ({ cli, directory, expect }) => {
  const home = join(directory, 'multi-word-home')
  await config(home, {
    $schemaVersion: 2,
    crossFields: { $type: 'prompt', $exec: 'Instructions', $description: 'device', $tags: ['qa'] },
    allOneField: { $type: 'prompt', $exec: 'Instructions', $description: 'device qa' },
    missingWord: { $type: 'prompt', $exec: 'Instructions', $description: 'device', $tags: ['ops'] },
  })

  for (const query of ['device qa', ' device\tqa ', 'device\nqa', 'device zebra']) {
    const result = await run(cli, home, ['get', query, '--search', '--agent'])
    expect(result.status).toBe(0)
    const paths = [...result.stdout.matchAll(/^- (\S+)/gm)].map(match => match[1])
    expect(paths).toEqual(query === 'device zebra' ? [] : ['crossFields', 'allOneField'])
  }
})

test('expands private markers through compositions without evaluating scripts or escaped examples', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'private-home')
  const marker = '{{-woof:private-}}'
  const effect = join(directory, 'must-not-run')
  await config(home, {
    $schemaVersion: 2,
    account: { $type: 'prompt', $private: true, $exec: marker },
    alias: '{{account}}',
    composite: 'Use {{alias}}; again: {{account}}.',
    example: '{{{{-woof:private-}}}} {{-internal-}} {{ordinary}}',
    malformed: '{{-unfinished{{-woof:private-}}',
    '-internal-': 'must not resolve',
    ordinary: 'normal reference',
    file: '<root>/placeholder.txt',
    output: { $type: 'node', $exec: `process.stdout.write(${JSON.stringify(marker)})` },
    ...Object.fromEntries(
      ['bash', 'node', 'tsx', 'bun'].map(type => [type, { $type: type, $private: true, $exec: marker }]),
    ),
    sequence: {
      $type: 'node',
      $exec: [`require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran')`, marker, '<root>/missing.js'],
    },
  })
  await put(join(home, 'placeholder.txt'), `Credentials: ${marker}`)
  const message =
    'Token "account" needs a value because its private content was omitted during export. Ask the user to provide it, then update the token with woof edit.'
  const result = await run(cli, home, ['get', 'composite', '--agent'])
  expect(result).toMatchObject({ status: 0, stdout: `Use ${message}; again: ${message}.` })
  expect(result.stderr.split('Token "account" needs a value')).toHaveLength(2)
  expect(result.stdout).not.toContain(marker)
  expect(await run(cli, home, ['get', 'example'])).toMatchObject({
    status: 0,
    stdout: `${marker} {{-internal-}} normal reference`,
    stderr: '',
  })
  expect(await run(cli, home, ['get', 'output'])).toMatchObject({ status: 0, stdout: marker, stderr: '' })
  for (const path of ['bash', 'node', 'tsx', 'bun', 'sequence', 'file', 'malformed']) {
    const access = await run(cli, home, ['get', path])
    expect(access.status).toBe(0)
    expect(access.stdout).toContain(`Token "${path}" needs a value`)
    expect(access.stderr).toContain(`Token "${path}" needs a value`)
    expect(access.stdout).not.toContain(marker)
  }
  expect(existsSync(effect)).toBe(false)
  expect((await run(cli, home, ['validate'])).status).toBe(0)
})

test('preserves export privacy through content edits, file edits and project overrides', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'authoring-home')
  const marker = '{{-woof:private-}}'
  await config(home, {
    $schemaVersion: 2,
    file: { $type: 'prompt', $private: true, $exec: '<root>/account.txt' },
    alias: '{{file}}',
    privateAlias: { $type: 'prompt', $private: true, $exec: '{{file}}' },
    publicPrompt: { $type: 'prompt', $exec: 'already public' },
    $projects: { demo: {} },
  })
  await put(join(home, 'account.txt'), marker)
  expect(
    (
      await run(cli, home, [
        'add',
        'account',
        '--type',
        'prompt',
        '--private',
        '--content',
        marker,
        '--shared',
        '--agent',
      ])
    ).status,
  ).toBe(0)
  expect((await run(cli, home, ['edit', 'account', '--content', 'shared:password', '--agent'])).status).toBe(0)
  expect((await run(cli, home, ['edit', 'account', '--description', 'Testing account', '--agent'])).status).toBe(0)
  expect(
    (
      await run(cli, home, [
        'edit',
        'account',
        '--project',
        'demo',
        '--override',
        '--content',
        'local:password',
        '--agent',
      ])
    ).status,
  ).toBe(0)
  expect((await run(cli, home, ['edit', 'file', '--content', 'file:password', '--agent'])).status).toBe(0)
  const saved = JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8'))
  expect(saved.account).toMatchObject({ $private: true, $exec: 'shared:password', $description: 'Testing account' })
  expect(saved.$projects.demo.account).toMatchObject({ $private: true, $exec: 'local:password' })
  expect(saved.file).toMatchObject({ $private: true, $exec: '<root>/account.txt' })
  expect(await readFile(join(home, 'account.txt'), 'utf8')).toBe('file:password')
  expect(await run(cli, home, ['get', 'account', '--project', 'demo'])).toMatchObject({
    status: 0,
    stdout: 'local:password',
    stderr: '',
  })
  expect((await run(cli, home, ['edit', 'account', '--project', 'demo', '--no-private', '--agent'])).status).toBe(0)
  expect(JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8')).$projects.demo.account).toEqual({
    $type: 'prompt',
    $exec: 'local:password',
    $description: 'Testing account',
  })
  const before = await readFile(join(home, 'woof.config.json'))
  for (const path of ['alias', 'publicPrompt']) {
    const result = await run(cli, home, ['edit', path, '--no-private', '--agent'])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('No changes')
    expect(await readFile(join(home, 'woof.config.json'))).toEqual(before)
  }
  expect((await run(cli, home, ['edit', 'account', '--private', '--no-private', '--agent'])).status).toBe(1)
  expect(await readFile(join(home, 'woof.config.json'))).toEqual(before)
  expect((await run(cli, home, ['edit', 'privateAlias', '--no-private', '--agent'])).status).toBe(0)
  expect(JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8')).privateAlias).toBe('{{file}}')
  expect((await run(cli, home, ['get', '--search', '--agent'])).stdout).toMatch(/privateAlias[^\n]*alias of file/)
})
