// Renders assets/icon.svg to the PNG icons in public/icons with headless Chromium.
// Usage: node scripts/make-icons.ts [previewDir]   (previewDir also gets a 1024px preview)
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page } from '@playwright/test'

type Variant = 'full' | 'maskable' | 'favicon' | 'badge'

interface Output {
  file: string
  size: number
  variant: Variant
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

const OUTPUTS: Output[] = [
  { file: 'apple-touch-icon.png', size: 180, variant: 'full' },
  { file: 'icon-192.png', size: 192, variant: 'full' },
  { file: 'icon-512.png', size: 512, variant: 'full' },
  // Android masks maskable icons to as little as the central 80% circle.
  { file: 'icon-maskable-512.png', size: 512, variant: 'maskable' },
  { file: 'favicon-64.png', size: 64, variant: 'favicon' },
  // Android status-bar badge: white silhouette on transparent.
  { file: 'badge-96.png', size: 96, variant: 'badge' },
]

function scaleArt(svg: string, factor: number): string {
  const transform = `translate(512 512) scale(${factor}) translate(-512 -512)`
  if (!svg.includes('<g id="art">')) throw new Error('assets/icon.svg must contain <g id="art">')
  return svg.replace('<g id="art">', `<g id="art" transform="${transform}">`)
}

function hide(svg: string, selectors: string): string {
  return svg.replace('</defs>', `</defs><style>${selectors}{display:none}</style>`)
}

function variantSvg(svg: string, variant: Variant): string {
  switch (variant) {
    case 'full':
    case 'favicon':
      return svg
    case 'maskable':
      return scaleArt(svg, 0.8)
    case 'badge':
      return scaleArt(hide(svg, '#bg,#glow'), 1.45)
  }
}

async function render(page: Page, svg: string, size: number, variant: Variant): Promise<Buffer> {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  const style = [
    'display:block',
    variant === 'favicon' ? `border-radius:${Math.round(size * 0.2237)}px` : '',
    variant === 'badge' ? 'filter:brightness(0) invert(1)' : '',
  ].join(';')
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent"><img src="${src}" width="${size}" height="${size}" style="${style}"></body></html>`,
  )
  await page.locator('img').evaluate((img: HTMLImageElement) => img.decode())
  const transparent = variant === 'favicon' || variant === 'badge'
  return page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: transparent, type: 'png' })
}

async function main(): Promise<void> {
  const previewDir = process.argv[2] ? resolve(process.argv[2]) : null
  const svg = await readFile(join(root, 'assets', 'icon.svg'), 'utf8')
  await mkdir(outDir, { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 })
    for (const { file, size, variant } of OUTPUTS) {
      await writeFile(join(outDir, file), await render(page, variantSvg(svg, variant), size, variant))
      console.log(`public/icons/${file}  ${size}×${size}`)
    }
    if (previewDir) {
      await mkdir(previewDir, { recursive: true })
      await writeFile(join(previewDir, 'icon-1024.png'), await render(page, svg, 1024, 'full'))
      await writeFile(join(previewDir, 'icon-maskable-1024.png'), await render(page, variantSvg(svg, 'maskable'), 1024, 'maskable'))
      console.log(`preview → ${previewDir}`)
    }
  } finally {
    await browser.close()
  }
}

await main()
