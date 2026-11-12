import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { put, test } from '../fixtures.ts'

test('preserves failed script diagnostics without resolving or continuing execution', async ({
  cli,
  directory,
  expect,
}) => {
  const home = join(directory, 'home')
  const effect = join(directory, 'continued')
  const report = 'FAIL  Acceptance present: pending unit\nresult  FAIL\n'
  const warning = 'Runtime warning\n'
  await put(
    join(cli.taskHome, '.agents/skills/woof-execution/SKILL.md'),
    await readFile(new URL('../../../skills/woof-execution/SKILL.md', import.meta.url), 'utf8'),
  )
  await put(
    join(home, 'validator script.js'),
    `const status = Number(process.argv[2]);
process.stdout.write(status ? ${JSON.stringify(report)} : 'result  PASS\\n');
process.stderr.write(${JSON.stringify(warning)});
process.exitCode = status;`,
  )
  await put(
    join(home, 'woof.config.json'),
    JSON.stringify({
      $schemaVersion: 2,
      validator: { $type: 'node', $exec: '<root>/validator script.js' },
      sequence: {
        $type: 'node',
        $exec: [
          'process.stdout.write("earlier payload")',
          '<root>/validator script.js',
          `require('fs').writeFileSync(${JSON.stringify(effect)}, 'ran')`,
        ],
      },
      composed: 'partial prefix {{sequence}} partial suffix',
    }),
  )
  const run = (path: string, status: string) =>
    cli.run(process.execPath, [cli.entry, 'get', path, '--args', status, '--agent'], cli.project, { WOOF_HOME: home })
  expect(await run('validator', '0')).toEqual({ status: 0, stdout: 'result  PASS\n', stderr: warning })
  for (const path of ['validator', 'composed']) {
    const result = await run(path, '17')
    expect(result.status).toBe(1)
    expect(result.stderr).toBe(warning + report)
    expect(result.stdout).toContain('failed with exit 17')
    expect(result.stdout).not.toContain(report)
    expect(result.stdout).not.toMatch(/earlier payload|partial prefix|partial suffix/)
    expect(existsSync(effect)).toBe(false)
  }
})
