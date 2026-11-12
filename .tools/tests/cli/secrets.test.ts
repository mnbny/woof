import { strToU8, unzipSync, zipSync } from 'fflate'
import { existsSync } from 'node:fs'
import { chmod, link, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

async function config(home: string, tokens: object) {
  await put(join(home, 'woof.config.json'), JSON.stringify({ $schemaVersion: 2, ...tokens }))
}

test('checks prompt and script secrets before effects and isolates script bindings per token and project', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'secrets-home')
  const effect = join(directory, 'effect')
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args], cli.project, { WOOF_HOME: home, TOKEN: 'ambient' })
  const script = (key: string) => ({
    $type: 'node',
    $secrets: { TOKEN: key },
    $exec: `require('fs').appendFileSync(${JSON.stringify(effect)}, process.env.TOKEN); process.stdout.write('ok')`,
  })
  await config(home, {
    first: script('provider.one'),
    second: script('provider.two'),
    both: '{{first}}{{second}}',
    prompt: { $type: 'prompt', $exec: 'Instructions', $secrets: { PROMPT_TOKEN: 'empty' } },
    mixed: '{{first}}{{prompt}}',
    deferred: '{{~second~}}',
    placeholder: { ...script('absent'), $exec: '{{-woof:private-}}', $private: true },
    $projects: { demo: { second: script('provider.three') } },
  })
  await put(join(home, 'woof.secrets.json'), JSON.stringify({ provider: { one: 'dummy-one\n\n' }, empty: '' }))
  const missing = await run(['get', 'both', '--agent'])
  expect(missing.status).toBe(1)
  expect(missing.stdout).toContain('second: TOKEN ← provider.two')
  expect(missing.stdout).not.toContain('dummy-one')
  expect(existsSync(effect)).toBe(false)
  expect((await run(['get', 'mixed', '--agent'])).status).toBe(1)
  expect(existsSync(effect)).toBe(false)
  expect((await run(['get', 'deferred', '--agent'])).status).toBe(0)
  expect((await run(['get', 'placeholder', '--agent'])).status).toBe(1)
  await put(
    join(home, 'woof.secrets.json'),
    JSON.stringify({
      provider: { one: 'dummy-one\n\n', two: 'dummy-two', three: 'dummy-three' },
      absent: 'dummy-placeholder',
    }),
  )
  for (const flags of [[], ['--agent'], ['--agent', '--project', 'demo']])
    expect(await run(['get', 'both', ...flags])).toMatchObject({ status: 0, stdout: 'okok' })
  expect(await readFile(effect, 'utf8')).toBe('dummy-one\n\ndummy-twodummy-one\n\ndummy-twodummy-one\n\ndummy-three')
  expect((await run(['get', 'placeholder', '--agent'])).status).toBe(0)
})

test('prompt instructions compose without values and authoring checks and preserves bindings', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'prompt-secrets')
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  await config(home, {
    a: { $type: 'prompt', $exec: 'First instructions.', $secrets: { TOKEN: 'one' } },
    b: { $type: 'prompt', $exec: '<root>/prompt.txt', $secrets: { TOKEN: 'two' } },
    combined: '{{a}}\n{{b}}',
    alias: '{{a}}',
    later: '{{~a~}}',
  })
  await put(join(home, 'prompt.txt'), 'Second instructions.')
  await put(
    join(home, 'woof.secrets.json'),
    JSON.stringify({ one: 'DUMMY_MUST_NOT_LEAK', two: 'dummy-two', three: 'dummy-three' }),
  )
  for (const command of [['get', 'combined'], ['get', 'alias'], ['explain', 'combined'], ['validate']]) {
    const result = await run(command)
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout + result.stderr).not.toContain('DUMMY_MUST_NOT_LEAK')
  }
  const combined = (await run(['get', 'combined'])).stdout
  expect(combined).toContain('Secrets for token a: TOKEN ← one')
  expect(combined).toContain('Secrets for token b: TOKEN ← two')
  expect(combined).toContain('TOKEN="$(woof secret \'one\')"')
  expect(combined).toContain('TOKEN="$(woof secret \'two\')"')
  expect(combined).not.toContain('secrets run')
  expect(combined.indexOf('First instructions.')).toBeLessThan(combined.indexOf('Secrets for token b'))
  expect((await run(['get', 'later'])).stdout).not.toContain('Secrets for token')
  expect((await run(['edit', 'a', '--description', 'Updated'])).status).toBe(0)
  expect((await run(['get', 'a'])).stdout).toContain('TOKEN ← one')
  expect((await run(['edit', 'a', '--secret', 'OTHER=three'])).status).toBe(0)
  expect((await run(['get', 'a'])).stdout).toContain('OTHER ← three')
  expect((await run(['edit', 'a', '--secret', ''])).status).toBe(0)
  expect((await run(['get', 'a'])).stdout).toBe('First instructions.')
  expect(
    (await run(['add', 'new', '--shared', '--type', 'prompt', '--content', 'New.', '--secret', 'TOKEN=missing']))
      .status,
  ).toBe(1)
  expect(JSON.parse(await readFile(join(home, 'woof.config.json'), 'utf8'))).not.toHaveProperty('new')
})

test('secret lookup has a raw output contract in both modes, including when config is broken', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'lookup-secrets')
  const dummy = 'dummy " $() ` \\ {{literal}} <root>/literal \n\n'
  const path = 'provider.account.key'
  await put(join(home, 'woof.config.json'), 'INVALID_CONFIG')
  await put(
    join(home, 'woof.secrets.json'),
    JSON.stringify({ provider: { account: { key: dummy, empty: '' } }, '--help': dummy, '--migrate': dummy }),
  )
  for (const entry of [cli.entry, cli.sourceEntry]) {
    const run = (args: string[]) =>
      cli.run(process.execPath, [entry, 'secret', ...args], cli.project, { WOOF_HOME: home, AI_AGENT: '1' })
    for (const flags of [[], ['--agent']]) {
      expect(await run([path, ...flags])).toEqual({ status: 0, stdout: dummy, stderr: '' })
      for (const key of ['--help', '--migrate'])
        expect(await run([...flags, '--', key])).toEqual({ status: 0, stdout: dummy, stderr: '' })
      for (const args of [
        ['absent'],
        ['provider.account.empty'],
        ['provider'],
        ['provider.account'],
        ['provider.account.key.child'],
        ['provider.__proto__'],
        [],
        [path, 'two'],
        ['bad/key'],
        [path, '--migrate'],
        [path, '--unknown'],
      ]) {
        const failed = await run([...args, ...flags])
        expect(failed.status).toBe(1)
        expect(failed.stdout).toBe('')
        expect(failed.stderr).not.toContain(dummy)
        expect(failed.stderr).not.toContain('woof execution skill')
      }
    }
  }
  const absentHome = join(directory, 'absent-lookup-home')
  const absent = await cli.run(process.execPath, [cli.entry, 'secret', 'one', '--agent'], cli.project, {
    WOOF_HOME: absentHome,
  })
  expect(absent).toMatchObject({ status: 1, stdout: '' })
  expect(existsSync(absentHome)).toBe(false)
})

test('rejects flat dotted keys and invalid secret namespaces without disclosing contents or blocking discovery', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'invalid-secret-namespaces')
  const store = join(home, 'woof.secrets.json')
  const dummy = 'DUMMY_MUST_NOT_LEAK'
  await config(home, {
    unrelated: 'No secret dependency',
    task: { $type: 'prompt', $exec: 'Instructions', $secrets: { TOKEN: 'provider.key' } },
  })
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  for (const value of [
    { 'provider.key': dummy },
    { provider: { 'nested.key': dummy } },
    { provider: { constructor: dummy } },
    { provider: { ['__proto__']: dummy } },
    { provider: { key: [dummy] } },
    { provider: { key: 42 } },
    { provider: { key: null, another: dummy } },
    { provider: { key: `${dummy}\0` } },
    { provider: { key: { $type: 'prompt', $exec: dummy } } },
    { $schemaVersion: 2, provider: { key: dummy } },
  ]) {
    const content = JSON.stringify(value)
    await put(store, content)
    const raw = await run(['secret', 'provider.key'])
    expect(raw.status).toBe(1)
    expect(raw.stdout).toBe('')
    expect(raw.stderr).toContain('Use nested namespaces with token names and string values')
    const preflight = await run(['get', 'task'])
    expect(preflight.status).toBe(1)
    expect(preflight.stdout + preflight.stderr + raw.stderr).not.toContain(dummy)
    expect((await run(['get', '--search'])).status).toBe(0)
    expect((await run(['get', 'unrelated'])).stdout).toBe('No secret dependency')
    expect(await readFile(store, 'utf8')).toBe(content)
  }
})

test('generated prompt prefixes supply values to ordinary shell commands without displaying them', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'prefix-secrets')
  const dummy = 'dummy " $() ` \\ with spaces'
  const script = join(directory, 'consumer.mjs')
  await put(
    script,
    'if(process.env.TOKEN !== process.env.EXPECTED || process.env.OTHER !== "second") process.exit(1); process.stdout.write("received"); process.exit(23)',
  )
  await config(home, {
    task: { $type: 'prompt', $exec: 'Run the consumer.', $secrets: { TOKEN: 'provider.key', OTHER: '--help' } },
  })
  await put(join(home, 'woof.secrets.json'), JSON.stringify({ provider: { key: dummy }, '--help': 'second' }))
  for (const entry of [cli.entry, cli.sourceEntry]) {
    const launcher = join(cli.bin, 'woof')
    await put(launcher, `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`)
    await chmod(launcher, 0o700)
    const markers = { WOOF_HOME: home, EXPECTED: dummy }
    const prompt = await cli.run(process.execPath, [entry, 'get', 'task', '--agent'], cli.project, markers)
    expect(prompt.status, prompt.stdout).toBe(0)
    expect(prompt.stdout + prompt.stderr).not.toContain(dummy)
    const prefix = /prepend (.+) to the command\./.exec(prompt.stdout)![1]!
    const result = await cli.run('/bin/sh', ['-c', `${prefix} '${process.execPath}' '${script}'`], cli.project, markers)
    expect(result).toEqual({ status: 23, stdout: 'received', stderr: '' })
  }
})

test('reference checks cover secret dependencies with the existing immediate and deferred boundaries', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'reference-secrets')
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  await config(home, {
    target: { $type: 'prompt', $exec: 'Target', $secrets: { TOKEN: 'absent' } },
    alias: '{{target}}',
    deferred: '{{~target~}}',
    missing: '{{~unknown~}}',
    unused: 'Unrelated',
    $projects: { demo: { target: { $type: 'prompt', $exec: 'Override', $secrets: { TOKEN: 'available' } } } },
  })
  await put(join(home, 'woof.secrets.json'), JSON.stringify({ available: 'DUMMY_MUST_NOT_LEAK' }))
  for (const command of [
    ['get', 'target'],
    ['get', 'alias'],
    ['explain', 'alias'],
    ['validate', 'target'],
    ['validate', 'deferred'],
  ]) {
    const result = await run(command)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('target: TOKEN ← absent')
    expect(result.stdout + result.stderr).not.toContain('DUMMY_MUST_NOT_LEAK')
  }
  expect((await run(['validate', 'deferred'])).stdout).toContain('deferred ~> target')
  expect((await run(['get', 'deferred'])).status).toBe(0)
  expect((await run(['get', 'missing'])).status).toBe(1)
  expect((await run(['validate', 'unused'])).status).toBe(0)
  expect((await run(['validate', 'deferred', '--project', 'demo'])).status).toBe(0)
  const all = await run(['validate'])
  expect(all.stdout).toContain('target: TOKEN ← absent')
  expect(all.stdout).toContain('unknown')
  await put(join(home, 'woof.secrets.json'), '{ "broken": "DUMMY_MUST_NOT_LEAK')
  for (const command of [
    ['get', 'target'],
    ['explain', 'target'],
    ['validate', 'target'],
  ]) {
    const result = await run(command)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Invalid JSON in woof.secrets.json')
    expect(result.stdout + result.stderr).not.toContain('DUMMY_MUST_NOT_LEAK')
  }
  expect((await run(['get', 'unused'])).status).toBe(0)
})

test('store failures never echo input and resource paths cannot disclose the store through links', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'guarded-secrets')
  const store = join(home, 'woof.secrets.json')
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  await config(home, { task: { $type: 'node', $exec: 'process.stdout.write("ran")', $secrets: { TOKEN: 'one' } } })
  for (const content of [
    '{ "one": "DUMMY_VALUE_DO_NOT_ECHO',
    JSON.stringify({ one: { value: 'DUMMY_VALUE_DO_NOT_ECHO' } }),
  ]) {
    await put(store, content)
    const result = await run(['get', 'task'])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('DUMMY_VALUE_DO_NOT_ECHO')
    expect(result.stdout).not.toContain('ran')
  }
  await put(store, JSON.stringify({ one: 'DUMMY_VALUE_DO_NOT_ECHO' }))
  await symlink(store, join(home, 'alias.json'))
  await link(store, join(home, 'hardlink.json'))
  for (const file of ['woof.secrets.json', 'alias.json', 'hardlink.json']) {
    await config(home, { disclose: `<root>/${file}` })
    const result = await run(['get', 'disclose'])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('DUMMY_VALUE_DO_NOT_ECHO')
    expect((await run(['add', 'other', '--shared', '--type', 'prompt', '--content', join(home, file)])).status).toBe(1)
  }
})

test('sharing retains bindings, excludes stores and backups, and does not reuse a differently bound token', async ({
  cli,
  directory,
  expect,
}) => {
  const source = join(directory, 'export-secrets')
  const destination = join(directory, 'import-secrets')
  const run = (home: string, args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  const task = (key: string) => ({ $type: 'node', $exec: 'process.stdout.write("ran")', $secrets: { TOKEN: key } })
  await config(source, { dependency: task('one'), $projects: { demo: { call: '{{dependency}}' } } })
  await put(join(source, 'woof.secrets.json'), JSON.stringify({ one: 'DUMMY_SOURCE_VALUE' }))
  const exported = await run(source, ['export', '$projects.demo'])
  expect(exported.status, exported.stdout).toBe(0)
  const archivePath = /^Archive: (.+)$/m.exec(exported.stdout)![1]!
  const bytes = await readFile(archivePath)
  const raw = unzipSync(bytes)
  expect(Object.keys(raw)).not.toContain('woof.secrets.json')
  expect(
    Object.values(raw)
      .map(value => Buffer.from(value).toString())
      .join(''),
  ).not.toContain('DUMMY_SOURCE_VALUE')
  expect(JSON.parse(Buffer.from(raw['woof.config.json']!).toString()).dependency.$secrets).toEqual({ TOKEN: 'one' })
  await config(destination, { different: task('two') })
  await put(join(destination, 'woof.secrets.json'), 'DUMMY_INVALID_LOCAL_STORE')
  const imported = await run(destination, ['import', archivePath])
  expect(imported.status, imported.stdout).toBe(0)
  expect(imported.stdout).toContain('dependency: TOKEN ← one')
  expect(imported.stdout).not.toContain('different: TOKEN ← two')
  expect(imported.stdout + imported.stderr).not.toContain('DUMMY_INVALID_LOCAL_STORE')
  expect((await run(destination, ['validate', '--project', 'demo'])).status).toBe(1)
  expect(imported.stderr).toContain('Invalid JSON in woof.secrets.json')
  expect(await readFile(join(destination, 'woof.secrets.json'), 'utf8')).toBe('DUMMY_INVALID_LOCAL_STORE')
  const backups = await readdir(join(destination, '.backups'))
  const backup = unzipSync(await readFile(join(destination, '.backups', backups[0]!)))
  expect(Object.keys(backup)).not.toContain('woof.secrets.json')
  expect(
    Object.values(backup)
      .map(value => Buffer.from(value).toString())
      .join(''),
  ).not.toContain('DUMMY_INVALID_LOCAL_STORE')
  await put(join(destination, 'woof.secrets.json'), '{}')
  expect((await run(destination, ['get', 'call', '--project', 'demo'])).status).toBe(1)
  await put(join(destination, 'woof.secrets.json'), JSON.stringify({ one: 'dummy-installed' }))
  expect(await run(destination, ['get', 'call', '--project', 'demo'])).toMatchObject({ status: 0, stdout: 'ran' })
})

test('import refuses a secret-store payload or a local alias to the store without touching values', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'import-guard')
  await config(home, {})
  const store = join(home, 'woof.secrets.json')
  await put(store, 'DUMMY_KEEP_ORIGINAL')
  await symlink(store, join(home, 'alias.txt'))
  for (const path of ['woof.secrets.json', 'Woof.Secrets.json', 'alias.txt']) {
    const archive = join(directory, `${path}.zip`)
    await writeFile(
      archive,
      zipSync({
        'woof.config.json': strToU8(
          JSON.stringify({ $schemaVersion: 2, $projects: { demo: { payload: `<root>/${path}` } } }),
        ),
        [path]: strToU8('incoming'),
      }),
    )
    const result = await cli.run(process.execPath, [cli.entry, 'import', archive, '--agent'], cli.project, {
      WOOF_HOME: home,
    })
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('DUMMY_KEEP_ORIGINAL')
    expect(await readFile(store, 'utf8')).toBe('DUMMY_KEEP_ORIGINAL')
  }
})

test('ordinary catalog operations survive an unusable store and long one-line content remains literal', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'unusable-store')
  await config(home, {})
  await symlink('woof.secrets.json', join(home, 'woof.secrets.json'))
  const content = 'Long inline instructions. '.repeat(20)
  const run = (args: string[]) =>
    cli.run(process.execPath, [cli.entry, ...args, '--agent'], cli.project, { WOOF_HOME: home })
  expect((await run(['add', 'long', '--shared', '--type', 'prompt', '--content', content])).status).toBe(0)
  expect(await run(['get', 'long'])).toMatchObject({ status: 0, stdout: content })
  const rule = 'Do not read $WOOF_HOME/woof.secrets.json'
  expect((await run(['add', 'rule', '--shared', '--type', 'prompt', '--content', rule])).status).toBe(0)
  expect(await run(['get', 'rule'])).toMatchObject({ status: 0, stdout: rule })
  expect((await run(['validate'])).status).toBe(0)
  const lookup = await run(['secret', 'absent'])
  expect(lookup.status).toBe(1)
  expect(lookup.stdout).toBe('')
  expect(lookup.stderr).toContain('Could not read woof.secrets.json')
  expect(lookup.stderr).not.toContain('woof execution skill')
})
