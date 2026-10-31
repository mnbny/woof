import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'

const repoRoot = process.cwd()
const entryPoint = join(repoRoot, 'cli', 'cli.ts')
const bundlePath = join(repoRoot, 'cli', 'woof.bundle.mjs')

// The bundle runs where node_modules does not exist, so a dependency that ships CommonJS cannot
// reach `require`. esbuild's interop shim uses the binding when one is in scope, so the banner
// supplies it.
const BANNER = `#!/usr/bin/env node
import{createRequire as __woofRequire}from'node:module';const require=__woofRequire(import.meta.url);`

// Lower than the release that building this repository needs. The consumer runs the bundle on
// whatever Node the machine already has, and this is the oldest release the dependencies support.
const TARGET = 'node20'

async function main() {
  const bundled = await build({
    banner: { js: BANNER },
    bundle: true,
    entryPoints: [entryPoint],
    format: 'esm',
    minify: true,
    platform: 'node',
    target: TARGET,
    write: false,
  })

  const [output] = bundled.outputFiles

  if (!output) throw new Error('esbuild produced no output file.')

  await writeFile(bundlePath, output.text)
  console.log(`Wrote ${relative(repoRoot, bundlePath)} (${output.text.length} bytes).`)
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`Bundle build failed: ${message}`)
  process.exitCode = 1
})
