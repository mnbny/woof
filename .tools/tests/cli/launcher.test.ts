import { expect } from 'vitest'

import { test } from '../fixtures.ts'

test('the source launcher resolves dependencies from its checkout when called elsewhere', async ({ cli }) => {
  const result = await cli.run(process.execPath, [cli.sourceEntry])

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('woof')
  expect(result.stderr).toBe('')
})

test('the compiled CLI runs outside the checkout without installed dependencies', async ({ cli }) => {
  const result = await cli.run(process.execPath, [cli.entry, '--help'])

  expect(result.status).toBe(0)
  expect(result.stdout).toContain('woof')
  expect(result.stderr).toBe('')
})
