import { readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { getWoofRoot } from './paths.ts'
import { renderTemplateFile } from './presentation.ts'

const SKILL = 'woof-execution'

// A copy without a readable version counts as version 0, so any release replaces it.
function skillVersion(file: string) {
  try {
    return Number(/^\s+version:\s*(\d+)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1] ?? 0)
  } catch {
    return undefined
  }
}

export function executionSkillState(source = getWoofRoot('skills', SKILL)) {
  const copies = ['.claude', '.agents'].map(directory => {
    const location = join(homedir(), directory, 'skills', SKILL)
    return { location, version: skillVersion(join(location, 'SKILL.md')) }
  })
  return { source, version: skillVersion(join(source, 'SKILL.md')), copies }
}

export function recommendExecutionSkill() {
  const { source, version, copies } = executionSkillState()
  const bundled = version ?? 0
  const installed = copies.filter(copy => copy.version !== undefined)
  const outdated = installed.filter(copy => copy.version! < bundled)

  let message: string | undefined
  if (!installed.length)
    message = renderTemplateFile('skill-missing', {
      source,
      claude: copies[0]!.location,
      agents: copies[1]!.location,
    })
  else if (outdated.length)
    message = renderTemplateFile('skill-outdated', {
      source,
      bundled,
      copies: outdated.map(copy => `- ${copy.location} (version ${copy.version})`).join('\n'),
    })
  // The process is exiting, so only a synchronous write is certain to reach the agent.
  if (message) writeSync(2, `\n${message}\n`)
}
