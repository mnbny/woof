import type { ResourceLocation } from './resources.ts'
import type { ScriptResource } from './schema.ts'
import type { TokenEvaluator } from './tokens.ts'

import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'

import { detectCheckoutRoot } from './resources.ts'

export const TSX_VERSION = '4.23.15'
export const BUN_VERSION = '1.4.4'

const OUTPUT_LIMIT = 10 * 1024 * 1024

export class ScriptExecutionError extends Error {
  readonly cancelled: boolean
  readonly status: number | null

  constructor(message: string, options: { cancelled?: boolean; status?: number | null; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause })
    this.name = 'ScriptExecutionError'
    this.cancelled = options.cancelled === true
    this.status = options.status ?? null
  }
}

function commandFor(kind: ScriptResource['$type'], source: string, location: ResourceLocation | undefined) {
  if (kind === 'bash') return { command: 'bash', args: location ? [location.file] : ['-c', source] }
  if (kind === 'node') return { command: process.execPath, args: location ? [location.file] : ['-e', source] }
  if (kind === 'tsx')
    return {
      command: 'npx',
      args: ['--yes', '--package', `tsx@${TSX_VERSION}`, 'tsx', ...(location ? [location.file] : ['-e', source])],
    }
  return {
    command: 'npx',
    args: ['--yes', '--package', `bun@${BUN_VERSION}`, 'bun', ...(location ? ['run', location.file] : ['-e', source])],
  }
}

function execute(
  kind: ScriptResource['$type'],
  source: string,
  location: ResourceLocation | undefined,
  options: { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal | undefined },
) {
  const { command, args } = commandFor(kind, source, location)
  const display = `${command} ${args.join(' ')}`
  return new Promise<string>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(
        new ScriptExecutionError(`Cancelled before starting ${display}; no script effects were attempted.`, {
          cancelled: true,
        }),
      )
      return
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: {
        ...options.env,
        CI: '1',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
        npm_config_progress: 'false',
        npm_config_update_notifier: 'false',
        npm_config_yes: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let size = 0
    let settled = false

    function finish(error?: ScriptExecutionError, output?: string) {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', cancel)
      if (error) reject(error)
      else resolve(output!)
    }

    function cancel() {
      child.kill('SIGTERM')
      finish(
        new ScriptExecutionError(`Cancelled ${display}. Prior script effects are not rolled back.`, {
          cancelled: true,
        }),
      )
    }

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > OUTPUT_LIMIT) {
        child.kill('SIGTERM')
        finish(new ScriptExecutionError(`${display} exceeded the ${OUTPUT_LIMIT}-byte output limit.`))
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk))
    child.on('error', error => {
      finish(new ScriptExecutionError(`Could not start ${display}: ${error.message}`, { cause: error }))
    })
    child.on('close', (code, signal) => {
      if (options.signal?.aborted) {
        cancel()
        return
      }
      if (code !== 0) {
        finish(
          new ScriptExecutionError(
            `${display} failed with ${code === null ? `signal ${signal}` : `exit ${code}`}. Prior script effects are not rolled back.`,
            { status: code },
          ),
        )
        return
      }
      finish(undefined, Buffer.concat(stdout).toString('utf8'))
    })
    options.signal?.addEventListener('abort', cancel, { once: true })
  })
}

export function createScriptEvaluator(
  options: {
    cwd?: string
    checkoutRoot?: string | undefined
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal | undefined
  } = {},
): TokenEvaluator {
  const callerCwd = options.cwd ?? process.cwd()
  const cwd = realpathSync(options.checkoutRoot ?? detectCheckoutRoot(callerCwd) ?? callerCwd)
  const env = options.env ?? process.env
  return async ({ resource, locations }) => {
    const executions = Array.isArray(resource.$exec) ? resource.$exec : [resource.$exec]
    let output = ''
    for (const [index, source] of executions.entries()) {
      if (options.signal?.aborted)
        throw new ScriptExecutionError(
          'Cancellation stopped the script array. Prior script effects are not rolled back.',
          {
            cancelled: true,
          },
        )
      output += await execute(resource.$type, source, locations[index], {
        cwd,
        env,
        signal: options.signal,
      })
    }
    return output
  }
}
