import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

async function main() {
  const { values } = parseArgs({ options: { sequential: { type: 'boolean', default: false } } })
  const { npm_lifecycle_event: event, npm_package_json: manifestPath, npm_execpath: packageManager } = process.env

  if (!event || !manifestPath || !packageManager) throw new Error('Run scripty through a package.json script.')

  const manifest: { scripts?: Record<string, string> } = JSON.parse(await readFile(manifestPath, 'utf8'))
  const scripts = Object.entries(manifest.scripts ?? {}).filter(([name]) => name.startsWith(`${event}:`))
  if (!scripts.length) throw new Error(`No scripts match ${event}:*.`)

  const ordered = scripts.map(([name, command]) => {
    const match = /^\s*SCRIPTY=(\S*)(?:\s+|$)/.exec(command)
    const value = match?.[1]
    if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))))
      throw new Error(`${name}: SCRIPTY must be a non-negative integer.`)
    return { name, order: value === undefined ? Infinity : Number(value) }
  })

  const run = (name: string) =>
    new Promise<number>((resolve, reject) => {
      const nodeScript = /\.[cm]?js$/.test(packageManager)
      spawn(
        nodeScript ? process.execPath : packageManager,
        nodeScript ? [packageManager, 'run', name] : ['run', name],
        { cwd: dirname(manifestPath), stdio: 'inherit' },
      )
        .once('error', reject)
        .once('close', code => resolve(code ?? 1))
    })

  if (values.sequential) {
    // Stable sorting preserves declaration order for equal numbers and unnumbered scripts.
    ordered.sort((a, b) => a.order - b.order)
    for (const { name } of ordered) {
      const code = await run(name)
      if (code !== 0) {
        process.exitCode = code
        return
      }
    }
  } else {
    const codes = await Promise.all(ordered.map(({ name }) => run(name)))
    process.exitCode = codes.find(code => code !== 0) ?? 0
  }
}

await main().catch((error: unknown) => {
  console.error(`scripty: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
