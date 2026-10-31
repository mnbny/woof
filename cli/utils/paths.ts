import { homedir } from 'node:os'
import { join } from 'node:path'

export function getWoofHome(...segments: string[]) {
  return join(process.env['WOOF_HOME']?.trim() || join(homedir(), '.woof'), ...segments)
}
