import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string }

// The exact contents of the published package. A file outside this list is a leak, and a missing one
// breaks woof at runtime, because the bundle reads templates, the readme, and the skill from the package.
const EXPECTED = [
  'LICENSE',
  'README.md',
  'cli/woof.bundle.mjs',
  'package.json',
  'skills/woof-execution/SKILL.md',
  // The configuration template is bundled into the code, so only the files read at runtime ship.
  ...readdirSync(join(repoRoot, 'cli', 'templates'))
    .filter(file => file.endsWith('.md') || file === 'editor.html')
    .map(file => `cli/templates/${file}`),
]

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
  console.log(`✓ ${message}`)
}

function pack(destination: string) {
  execFileSync('pnpm', ['build'], { cwd: repoRoot, stdio: 'inherit' })
  // Scripts are off because the build already ran, and their output would corrupt the JSON report.
  const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  const [report] = JSON.parse(output) as [{ filename: string; files: { path: string }[] }]
  return { tarball: join(destination, report.filename), files: report.files.map(file => file.path) }
}

function main() {
  const temp = mkdtempSync(join(tmpdir(), 'woof-pack-check-'))
  try {
    const { tarball, files } = pack(temp)
    const missing = EXPECTED.filter(file => !files.includes(file))
    const extra = files.filter(file => !EXPECTED.includes(file))
    check(
      !missing.length,
      `The package holds every runtime file${missing.length ? `. Missing: ${missing.join(', ')}` : ''}`,
    )
    check(!extra.length, `The package holds nothing else${extra.length ? `. Extra: ${extra.join(', ')}` : ''}`)

    // npm rewrites a manifest that it considers invalid only at publish time, so a dry run is the
    // one place to see it. The dry run uploads nothing.
    const dryRun = spawnSync('npm', ['publish', '--dry-run', '--ignore-scripts'], { cwd: repoRoot, encoding: 'utf8' })
    check(
      !dryRun.stderr.includes('auto-corrected'),
      `npm publishes the manifest unchanged${dryRun.stderr.includes('auto-corrected') ? `. Run npm pkg fix:\n${dryRun.stderr}` : ''}`,
    )

    // A fresh home, woof home, and npm cache, so the run sees what a first-time user sees.
    const work = join(temp, 'work')
    mkdirSync(work)
    const env = {
      ...process.env,
      HOME: join(temp, 'home'),
      WOOF_HOME: join(temp, 'woof'),
      npm_config_cache: join(temp, 'npm-cache'),
      npm_config_update_notifier: 'false',
    }
    const woof = (...args: string[]) =>
      spawnSync('npx', ['--yes', '--package', tarball, 'woof', ...args], { cwd: work, env, encoding: 'utf8' })

    check(woof('--version').stdout.trim() === manifest.version, `npx runs woof ${manifest.version}`)
    check(
      woof('readme', '--agent').stdout === readFileSync(join(repoRoot, 'README.md'), 'utf8'),
      'The readme command prints the packaged README',
    )

    const draft = woof('add', '--agent')
    check(
      draft.status === 1 && draft.stdout.includes('Draft the token from the conversation'),
      'Agent output reads its templates from the package',
    )
    const source = /To install, copy this directory:\n(.+)\n/.exec(draft.stderr)?.[1]
    check(
      Boolean(source && existsSync(join(source, 'SKILL.md'))) &&
        readFileSync(join(source!, 'SKILL.md'), 'utf8') ===
          readFileSync(join(repoRoot, 'skills', 'woof-execution', 'SKILL.md'), 'utf8'),
      'The skill offer points at the packaged execution skill',
    )

    const tokens = [
      ['pack.prompt', 'prompt', 'Hello from the package.'],
      ['pack.bash', 'bash', 'echo bash runs'],
      ['pack.node', 'node', "console.log('node runs')"],
    ] as const
    for (const [path, type, content] of tokens) {
      const added = woof(
        'add',
        path,
        '--type',
        type,
        '--content',
        content,
        '--description',
        'Pack check',
        '--shared',
        '--agent',
      )
      check(added.status === 0, `Add saves a ${type} token`)
    }
    check(woof('get', 'pack.prompt', '--agent').stdout.trim() === 'Hello from the package.', 'Get returns a prompt')
    check(woof('get', 'pack.bash', '--agent').stdout.trim() === 'bash runs', 'Get runs a bash script')
    check(woof('get', 'pack.node', '--agent').stdout.trim() === 'node runs', 'Get runs a node script')
    check(woof('validate', '--agent').status === 0, 'Validate passes')

    console.log(`Pack check passed: ${files.length} files in ${tarball.split('/').pop()}.`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

try {
  main()
} catch (error: unknown) {
  console.error(`pack-check: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
