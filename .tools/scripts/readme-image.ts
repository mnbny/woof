import { chromium } from 'playwright'
import sharp from 'sharp'

export function escapeHtml(text: string) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export async function renderReadmeImage(options: {
  content: string
  styles: string
  output: string
  width: number
  browserPath?: string | undefined
}) {
  const html = `<!doctype html>
<html lang="en" data-theme="coffee">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.7.50/daisyui.css" integrity="sha384-UwBu1IAWgb8nYSKlFTAgsMdqElJVcwjO1O31z47tHuvyhJ4rgjfif927I0JH2zI1" crossorigin="anonymous">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/daisyui@5.7.50/theme/coffee.css" integrity="sha384-qqdGitAgWSmI3kzDMAvw+yitfgYGWMosprlOArCcH00rMG+2PN6XI5fljOEgkaW4" crossorigin="anonymous">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--color-base-200); color: var(--color-base-content); --readme-font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  main { padding: 30px 32px; }
  ${options.styles}
</style>
</head>
<body><main>${options.content}</main></body>
</html>`
  const browser = await chromium.launch(
    options.browserPath ? { executablePath: options.browserPath } : { channel: 'chrome' },
  )
  try {
    const page = await browser.newPage({
      viewport: { width: options.width, height: 600 },
      deviceScaleFactor: 1024 / options.width,
    })
    await page.setContent(html, { waitUntil: 'load' })
    const stylesLoaded = await page
      .locator('link[rel="stylesheet"]')
      .evaluateAll(links => links.every(link => Boolean((link as unknown as { sheet: unknown }).sheet)))
    if (!stylesLoaded) throw new Error('Could not load daisyUI styles from the CDN.')
    const screenshot = await page.locator('main').screenshot({ animations: 'disabled' })
    await sharp(screenshot).jpeg({ quality: 90, chromaSubsampling: '4:4:4', mozjpeg: true }).toFile(options.output)
  } finally {
    await browser.close()
  }
  console.log(`Wrote ${options.output} at 1024 pixels wide.`)
}
