import { defineCommand } from 'citty'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs, promisify } from 'node:util'

import manifest from '../../package.json' with { type: 'json' }
import { fieldsText, inlineCodeText, listFieldText } from '../utils/display.ts'
import { presentError, presentSelection } from '../utils/presentation.ts'
import { executionSkillState } from '../utils/skill.ts'

async function npm(args: string[]) {
  const { stdout } = await promisify(execFile)('npm', args, {
    cwd: tmpdir(),
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      npm_config_update_notifier: 'false',
      npm_config_fetch_retries: '0',
      npm_config_fetch_timeout: '15000',
    },
  })
  return stdout.trim()
}

export default defineCommand({
  args: {
    agent: { description: 'Use plain, noninteractive agent output', type: 'boolean' },
  },
  meta: {
    description: 'Find the latest release and show how to update the command pin and execution skill',
    name: 'upgrade',
  },
  async run({ rawArgs }) {
    try {
      parseArgs({ args: rawArgs, options: { agent: { type: 'boolean' } } })
      const cache = await mkdtemp(join(tmpdir(), 'woof-upgrade-'))
      let version: unknown
      try {
        // npm can fall back to cached metadata on network failure, even with prefer-online.
        version = JSON.parse(
          await npm([
            'view',
            `${manifest.name}@latest`,
            'version',
            '--json',
            '--cache',
            cache,
            '--offline=false',
            '--prefer-offline=false',
            '--prefer-online',
          ]),
        )
      } finally {
        await rm(cache, { recursive: true, force: true })
      }
      if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version))
        throw new Error('npm did not return an exact release version.')

      // npm adds the requested package's bin directory to PATH. Read that package without running its CLI.
      const root = await npm([
        'exec',
        '--yes',
        '--ignore-scripts',
        '--offline=false',
        '--prefer-offline=false',
        `--package=${manifest.name}@${version}`,
        '--',
        'node',
        '-e',
        `const { join, delimiter } = require('node:path');
const { readFileSync } = require('node:fs');
const root = process.env.PATH.split(delimiter).map(path => join(path, '..', '@mnbny', 'woof')).find(path => {
  try {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    return pkg.name === process.argv[1] && pkg.version === process.argv[2];
  } catch { return false; }
});
if (!root) throw new Error('Could not locate the requested woof release in the npm cache.');
process.stdout.write(root);`,
        '--',
        manifest.name,
        version,
      ])
      const skill = executionSkillState(join(root, 'skills', 'woof-execution'))
      if (!skill.version || !Number.isSafeInteger(skill.version))
        throw new Error(`The woof ${version} package has no readable execution skill version.`)
      const copies = skill.copies
        .filter(copy => copy.version !== undefined)
        .map(copy => `${copy.location} (version ${copy.version})`)
      const command = `npx --yes ${manifest.name}@${version}`
      presentSelection(
        {
          summary: 'woof release information',
          details: [
            fieldsText([
              ['Running version', manifest.version],
              ['Latest release', version],
              ['Latest execution skill', String(skill.version)],
            ]),
            ...listFieldText('Installed skill', copies),
          ].join('\n'),
          recovery: `Use ${inlineCodeText(command)} for subsequent commands. Have your agent update its execution skill after switching to this version.`,
        },
        {
          template: 'upgrade-result',
          values: {
            current: manifest.version,
            latest: version,
            skill: skill.version,
            copies: copies.length ? copies.map(copy => `- ${copy}`).join('\n') : 'none',
            command,
            source: skill.source,
          },
        },
      )
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error)
      presentError(
        {
          summary: 'woof could not check the latest release.',
          details,
          recovery: 'Check npm access and your network connection, then retry woof upgrade.',
        },
        { template: 'upgrade-error', values: { details } },
      )
      process.exitCode = 1
    }
  },
})
