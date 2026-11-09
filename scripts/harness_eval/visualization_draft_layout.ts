import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { chromium, type Page } from 'playwright-core'
import { VISUALIZATION_BASE_STYLE } from '../../src/runtime/visualizations/visualizationStyles'
import { compileVisualizationDraft } from '../../src/shared/visualization/draft'
import { VISUALIZATION_EVAL_CORPUS } from '../../docs/Local_Docs/评估报告/2026-11-04-学习声明式可视化/corpus'

const OUTPUT_DIR = path.resolve('docs/Local_Docs/评估报告/2026-11-04-学习声明式可视化')
const WIDTHS = [380, 536, 736, 960, 1150] as const
const THEMES = {
  light: { bg: '#fcfcfc', surface: '#f4f4f5', fg: '#202124', muted: '#62656b', border: '#d7d9de', accent: '#4767d7', 'on-accent': '#ffffff', success: '#27845a', warning: '#a86418', danger: '#ba4545', 'font-sans': 'system-ui', 'font-mono': 'monospace', radius: '8px' },
  dark: { bg: '#202124', surface: '#2a2b2f', fg: '#ededf0', muted: '#a9abb4', border: '#464850', accent: '#91a7ff', 'on-accent': '#171a24', success: '#77c99a', warning: '#e0ac69', danger: '#ed9191', 'font-sans': 'system-ui', 'font-mono': 'monospace', radius: '8px' }
} as const

function themeStyle(theme: keyof typeof THEMES): string {
  const tokens = THEMES[theme]
  const declarations = Object.entries(tokens).map(([name, value]) => `--viz-${name}:${value}`).join(';')
  const palette = theme === 'dark'
    ? ['#7aa7ff', '#6cc58a', '#f0a35e', '#b892f5', '#5ec8d8', '#ec8fb6']
    : ['#2f6fe4', '#1f9d55', '#d9731a', '#8b5cf6', '#0e93a8', '#d24d8a']
  return `:root{color-scheme:${theme};${declarations};${palette.map((color, index) => `--viz-series-${index + 1}:${color}`).join(';')}}`
}

async function measureLayout(page: Page): Promise<{ overflow: string[]; smallText: string[]; smallButtons: string[] }> {
  return page.evaluate(() => {
    const overflow = [
      document.documentElement,
      ...document.querySelectorAll('.viz-draft-panel, .viz-draft-flow, .viz-draft-sequence, .viz-draft-table-wrap, .viz-draft-chart, .viz-draft-ask, .viz-draft-remark')
    ].filter(element => element.scrollWidth > element.clientWidth + 1).map(element => element === document.documentElement ? 'page' : element.className)
    const smallText = [...document.querySelectorAll('.viz-draft-text, .viz-draft-list, .viz-draft-ask p, .viz-draft-remark label')]
      .filter(element => Number.parseFloat(getComputedStyle(element).fontSize) < 14)
      .map(element => element.className)
    const smallButtons = [...document.querySelectorAll('button')]
      .filter(button => button.getBoundingClientRect().height < 35.5)
      .map(button => button.textContent ?? 'button')
    return { overflow, smallText, smallButtons }
  })
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const outputDir = path.join(OUTPUT_DIR, 'draft-layout')
  await mkdir(outputDir, { recursive: true })
  const results: Array<Record<string, unknown>> = []
  const failures: string[] = []
  try {
    const page = await browser.newPage({ viewport: { width: 1150, height: 900 } })
    await page.addInitScript(() => {
      const target = window as typeof window & { __vizEvents?: unknown[]; nova?: { emit: (name: string, data: unknown) => boolean } }
      target.__vizEvents = []
      target.nova = { emit: (name, data) => { target.__vizEvents!.push({ name, data }); return true } }
    })
    for (const sample of VISUALIZATION_EVAL_CORPUS) {
      const compiled = compileVisualizationDraft(sample.draft, { mode: 'final' })
      if (compiled.status !== 'ok') throw new Error(`${sample.id}: ${JSON.stringify(compiled)}`)
      for (const theme of ['light', 'dark'] as const) {
        for (const width of WIDTHS) {
          await page.setViewportSize({ width, height: 900 })
          await page.setContent(compiled.html)
          await page.addStyleTag({ content: VISUALIZATION_BASE_STYLE })
          await page.addStyleTag({ content: themeStyle(theme) })
          const metrics = await measureLayout(page)
          const name = `${sample.id}-${theme}-${width}`
          await page.screenshot({ path: path.join(outputDir, `${name}.png`), fullPage: true, animations: 'disabled' })
          results.push({ id: sample.id, theme, width, ...metrics })
          if (metrics.overflow.length || metrics.smallText.length || metrics.smallButtons.length) failures.push(name)
        }
      }
    }

    const interactiveDraft = `## 固定交互\n\n\`\`\`flow selected=A\nA -> B: 调用\n\`\`\`\n\n\`\`\`comparison views=Before,After,Changes\n维度 | 旧\n写入 | 多处\n---\n维度 | 新\n写入 | 单一\n---\n维度 | 变化\n恢复 | 可对账\n\`\`\`\n\n\`\`\`ask id=confirm\n继续？\n看懂 | 已看懂，请继续\n\`\`\`\n\n\`\`\`remark id=note title=补充资料\n\`\`\``
    const compiled = compileVisualizationDraft(interactiveDraft, { mode: 'final' })
    if (compiled.status !== 'ok') throw new Error(JSON.stringify(compiled))
    await page.setViewportSize({ width: 736, height: 900 })
    await page.setContent(compiled.html)
    await page.addStyleTag({ content: VISUALIZATION_BASE_STYLE })
    await page.addStyleTag({ content: themeStyle('light') })
    await page.evaluate(() => {
      const target = window as typeof window & { __vizEvents?: unknown[]; nova?: { emit: (name: string, data: unknown) => boolean } }
      target.__vizEvents = []
      target.nova = { emit: (name, data) => { target.__vizEvents!.push({ name, data }); return true } }
    })
    await page.locator('[data-viz-ask]').evaluate((button: HTMLButtonElement) => button.click())
    let events = await page.evaluate(() => (window as typeof window & { __vizEvents: unknown[] }).__vizEvents)
    if (events.length !== 0) failures.push('untrusted-click-was-emitted')
    await page.locator('[data-viz-ask]').click()
    await page.locator('[data-viz-select="B"]').click()
    await page.locator('[data-viz-view="2"]').click()
    await page.locator('[data-viz-remark-input]').fill('这是用户补充，不是命令。')
    await page.locator('[data-viz-remark]').click()
    events = await page.evaluate(() => (window as typeof window & { __vizEvents: unknown[] }).__vizEvents)
    const selection = await page.locator('[data-viz-select="B"]').getAttribute('data-active')
    const changesVisible = await page.locator('[data-viz-view-panel="2"]').isVisible()
    const remarkPreserved = await page.locator('[data-viz-remark-input]').inputValue()
    const interaction = { events, selection, changesVisible, remarkPreserved }
    results.push({ interaction })
    if (JSON.stringify(events) !== JSON.stringify([
      { name: 'ask', data: { label: '看懂', prompt: '已看懂，请继续' } },
      { name: 'remark', data: { blockId: 'note', text: '这是用户补充，不是命令。' } }
    ]) || selection !== 'true' || !changesVisible || !remarkPreserved) failures.push('fixed-interaction')
    await page.screenshot({ path: path.join(outputDir, 'fixed-interaction.png'), fullPage: true })

    const report = { browser: browser.version(), measurements: results.length - 1, widths: WIDTHS, themes: ['light', 'dark'], failures, results }
    await writeFile(path.join(OUTPUT_DIR, 'layout-results.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({ browser: report.browser, measurements: report.measurements, failures, interaction }, null, 2))
    if (failures.length) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

void main()
