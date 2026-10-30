import { intro, log, outro } from '@clack/prompts'
import { defineCommand } from 'citty'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import { isAgent } from '../utils/agent.ts'
import { DEFAULT_CONFIG } from '../utils/config.ts'
import { codeBlockText, shellQuote } from '../utils/display.ts'
import { getWoofHome } from '../utils/paths.ts'

export default defineCommand({
  args: {
    agent: { description: 'Create or show configuration and print plain agent guidance', type: 'boolean' },
    show: { description: 'Display the configuration contents', type: 'boolean' },
  },
  meta: { description: 'Create or show your Woof configuration', name: 'customize' },
  async run({ rawArgs }) {
    let humanReport = false

    try {
      const { values } = parseArgs({
        args: rawArgs,
        options: { agent: { type: 'boolean' }, show: { type: 'boolean' } },
      })
      const agent = values.agent === true || Boolean(isAgent())
      if (!agent) {
        intro('woof customize')
        humanReport = true
      }

      const file = getWoofHome('woof.config.json')
      await mkdir(dirname(file), { recursive: true })
      let created = false
      try {
        await writeFile(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
        created = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }

      const result = created ? `Created ${file}` : `Configuration already exists at ${file}`
      if (agent) console.log(result)
      else if (created) log.success(result)
      else log.info(result)

      const content = values.show ? JSON.stringify(JSON.parse(await readFile(file, 'utf8')), null, 2) : undefined

      if (agent) {
        if (content !== undefined) console.log(`\n${content}`)
        console.log(
          '\nShow the saved configuration with woof customize --agent --show.\n' +
            "To change settings, edit the reported file and preserve settings outside the user's request.\n" +
            'The current configuration contains only schemaVersion: 1. Product settings are not defined yet.\n' +
            'Both forms create the default configuration if absent. Existing files remain unchanged.\n' +
            'For command help, run woof customize --agent --help.',
        )
        return
      }

      log.info(values.show ? 'Your Woof configuration' : 'Open your Woof configuration with one of')
      log.message()
      log.message(
        codeBlockText(content ?? ['code', 'vim', 'open'].map(editor => `${editor} ${shellQuote(file)}`).join('\n')),
        { spacing: 0, withGuide: false },
      )
      outro('Edit the file to customize Woof.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (humanReport) {
        log.error(message)
        outro('Could not prepare your Woof configuration.')
      } else console.error(message)
      process.exitCode = 1
    }
  },
})
