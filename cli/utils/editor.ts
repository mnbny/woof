import type { IncomingMessage, ServerResponse } from 'node:http'

import { Marked } from 'marked'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

import { getWoofRoot } from './paths.ts'
import { renderTemplate } from './presentation.ts'

export type EditorSession = {
  state: () => unknown
  preview: (content: string) => string
  save: (input: Record<string, unknown>) => Promise<{ saved: true; result: unknown } | { saved: false; error: string }>
}
export type EditorOutcome<Result> = { outcome: 'saved'; result: Result } | { outcome: 'cancelled' | 'expired' }

const BODY_LIMIT = 5 * 1024 * 1024
// The page loads pinned daisyUI styles, with integrity hashes, from this path only.
const DAISY_UI = 'https://cdn.jsdelivr.net/npm/daisyui@5.7.50/'
const IDLE_LIMIT = 30 * 60 * 1000

function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

// Raw HTML in the content shows as text, so the preview cannot run markup from the token.
const markdown = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } })

export function renderPreview(content: string, type: string) {
  if (type === 'prompt') return markdown.parse(content, { async: false })
  const fence = '`'.repeat(Math.max(3, ...(content.match(/`+/g) ?? []).map(run => run.length + 1)))
  const language = type === 'node' ? 'js' : type === 'tsx' ? 'ts' : type === 'bun' ? 'ts' : 'bash'
  return markdown.parse(`${fence}${language}\n${content}\n${fence}`, { async: false })
}

export function openBrowser(url: string) {
  try {
    const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The caller prints the address, which works without a browser launcher.
  }
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('The request is too large.'))
        request.destroy()
      } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Any site in the browser can send requests to a local port. Only requests with the address host, the page origin,
 * and the secret path reach the session. The page runs only its own script, and loads styles only from daisyUI.
 * The announcement can return a cleanup. It runs as soon as the session ends, before other interrupt listeners print.
 */
export function runEditor<Result>(
  session: EditorSession,
  announce: (url: string) => ((outcome: EditorOutcome<Result>['outcome']) => void) | void,
) {
  const secret = randomBytes(24).toString('base64url')
  const nonce = randomBytes(16).toString('base64')
  const page = renderTemplate(readFileSync(getWoofRoot('cli', 'templates', 'editor.html'), 'utf8'), { nonce })
  const headers = {
    'cache-control': 'no-store',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' ${DAISY_UI}; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  }

  return new Promise<EditorOutcome<Result>>((resolve, reject) => {
    let port = 0
    let timer: NodeJS.Timeout | undefined
    let cleanup: ((outcome: EditorOutcome<Result>['outcome']) => void) | void
    const finish = (outcome: EditorOutcome<Result>) => {
      clearTimeout(timer)
      process.off('SIGINT', interrupt)
      cleanup?.(outcome.outcome)
      server.close()
      server.closeAllConnections()
      resolve(outcome)
    }
    const interrupt = () => finish({ outcome: 'cancelled' })
    const idle = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish({ outcome: 'expired' }), IDLE_LIMIT)
    }

    const server = createServer((request, response) => {
      void handle(request, response).catch(error => {
        if (!response.headersSent)
          send(response, 500, { error: error instanceof Error ? error.message : String(error) })
      })
    })

    function send(response: ServerResponse, status: number, body: unknown, done?: () => void) {
      const html = typeof body === 'string'
      response.writeHead(status, {
        ...headers,
        'content-type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      })
      response.end(html ? body : JSON.stringify(body), done)
    }

    async function handle(request: IncomingMessage, response: ServerResponse) {
      const origin = `http://127.0.0.1:${port}`
      const route = request.url?.startsWith(`/${secret}/`) ? request.url.slice(secret.length + 2) : undefined
      if (request.headers.host !== `127.0.0.1:${port}` || route === undefined)
        return send(response, 404, { error: 'Not found.' })
      idle()
      if (request.method === 'GET' && route === '') return send(response, 200, page)
      if (request.method !== 'POST' || request.headers.origin !== origin)
        return send(response, 403, { error: 'Forbidden.' })
      const input = JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>
      if (route === 'state') return send(response, 200, session.state())
      if (route === 'preview') return send(response, 200, { html: session.preview(String(input['content'] ?? '')) })
      if (route === 'cancel') return send(response, 200, {}, () => finish({ outcome: 'cancelled' }))
      if (route === 'save') {
        const saved = await session.save(input)
        if (!saved.saved) return send(response, 422, { error: saved.error })
        return send(response, 200, saved.result, () => finish({ outcome: 'saved', result: saved.result as Result }))
      }
      return send(response, 404, { error: 'Not found.' })
    }

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port
      const url = `http://127.0.0.1:${port}/${secret}/`
      process.on('SIGINT', interrupt)
      idle()
      cleanup = announce(url)
    })
  })
}
