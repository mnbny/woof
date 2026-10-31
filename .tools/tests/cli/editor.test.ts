import assert from 'node:assert/strict'
import { request } from 'node:http'
import { expect, test, vi } from 'vitest'

import { runEditor } from '../../../cli/utils/editor.ts'

function post(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const sent = request(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers } },
      response => {
        response.resume()
        resolve(response.statusCode!)
      },
    )
    sent.on('error', reject)
    sent.end('{}')
  })
}

// Any site open in the browser can send requests to a local port, so the server must answer only its own page.
test('the edit server answers only requests from its own page', async () => {
  let address = ''
  const saves: unknown[] = []
  const outcome = runEditor(
    {
      state: () => ({}),
      preview: content => content,
      save: async input => {
        saves.push(input)
        return { saved: true, result: 'saved' }
      },
    },
    url => {
      address = url
    },
  )
  await vi.waitFor(() => assert(address))
  const { origin, host } = new URL(address)

  expect(await post(`${address}save`, {})).toBe(403)
  expect(await post(`${address}save`, { origin: 'http://attacker.example' })).toBe(403)
  expect(await post(`${origin}/guessed/save`, { origin })).toBe(404)
  expect(await post(`${address}save`, { origin, host: `attacker.example:${new URL(address).port}` })).toBe(404)
  expect(saves).toEqual([])

  expect(await post(`${address}save`, { origin, host })).toBe(200)
  expect(await outcome).toEqual({ outcome: 'saved', result: 'saved' })
})
