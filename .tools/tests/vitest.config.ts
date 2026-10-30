import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const cli = await build({
  banner: {
    js: "import { createRequire as __woofRequire } from 'node:module'; const require = __woofRequire(import.meta.url);",
  },
  bundle: true,
  entryPoints: [fileURLToPath(new URL('../../cli/cli.ts', import.meta.url))],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
})

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['.tools/tests/**/*.test.ts'],
    maxWorkers: 2,
    provide: { cliSource: cli.outputFiles[0]!.text },
  },
})
