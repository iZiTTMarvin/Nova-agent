import type { Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

const TALL_TEXT = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段说明：${'内容 '.repeat(40)}`).join('\n\n')

type Harness = Parameters<Parameters<typeof test>[2]>[0]['nova']

/** 先输出一大段正文，再连续两次读取网页：工具组落在高消息的中部，起点在视口上方 */
function enqueueToolTurn(nova: Harness, tail: string): void {
  const toolCall = (index: number, id: string, args: string) => ({
    payload: { choices: [{ delta: { tool_calls: [{ index, id, function: { name: 'web_fetch', arguments: args } }] }, finish_reason: null }] }
  })
  nova.provider.enqueue(
    {
      kind: 'raw',
      events: [
        { payload: { choices: [{ delta: { content: `${TALL_TEXT}\n\n` }, finish_reason: null }] } },
        toolCall(0, 'call_fetch_1', '{"url":"http://127.0.0.1:9/a?token=secret#frag"}'),
        toolCall(1, 'call_fetch_2', '{"url":"http://127.0.0.1:9/b"}'),
        { payload: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }
      ]
    },
    { kind: 'text', text: tail }
  )
}

const scrollTop = (page: Page) => page.locator('.chat-messages').evaluate(el => el.scrollTop)
const topOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(el => el.getBoundingClientRect().top)

async function openProcess(page: Page): Promise<void> {
  const header = page.getByTestId('turn-process-header').first()
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
}

test('展开工具详情时标题留在原位，上滚后展开不被拉回底部', async ({ nova }, testInfo) => {
  const { page } = nova
  enqueueToolTurn(nova, `${TALL_TEXT}\n\nTOOL_TURN_DONE`)
  await nova.sendPrompt('读取文件并总结')
  await expect(page.getByText('TOOL_TURN_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await openProcess(page)

  const group = page.locator('.tool-call-group__header').first()
  await expect(group).toBeVisible()
  await expect(group).toHaveAttribute('aria-expanded', /true|false/)

  // 位置记录点：用户点击的标题，展开前后在视口中的位置应保持
  await page.locator('.chat-messages').evaluate(el => { el.scrollTop = el.scrollHeight })
  await group.evaluate(el => el.scrollIntoView({ block: 'center' }))
  const groupBefore = await topOf(page, '.tool-call-group__header')
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(600)
  const groupAfter = await topOf(page, '.tool-call-group__header')
  expect(Math.abs(groupAfter - groupBefore)).toBeLessThanOrEqual(3)

  const item = page.locator('.tool-call-group .tool-trace-row__header').first()
  await expect(item).toBeVisible()
  const itemBefore = await item.evaluate(el => el.getBoundingClientRect().top)
  await item.click()
  await expect(item).toHaveAttribute('aria-expanded', 'true')
  await page.waitForTimeout(600)
  await page.screenshot({ path: testInfo.outputPath('group-expanded.png') })
  const itemAfter = await item.evaluate(el => el.getBoundingClientRect().top)
  expect(Math.abs(itemAfter - itemBefore)).toBeLessThanOrEqual(3)

  // 用户上滚后再收起/展开：标题位置保持，滚动位置不被拉到底部
  await item.evaluate(el => el.scrollIntoView({ block: 'center' }))
  await page.locator('.chat-messages').hover()
  await page.mouse.wheel(0, -120)
  await page.waitForTimeout(300)
  const scrolledUp = await scrollTop(page)
  const heldBefore = await item.evaluate(el => el.getBoundingClientRect().top)
  await item.click()
  await expect(item).toHaveAttribute('aria-expanded', 'false')
  await page.waitForTimeout(600)
  const heldAfter = await item.evaluate(el => el.getBoundingClientRect().top)
  expect(Math.abs(heldAfter - heldBefore)).toBeLessThanOrEqual(3)
  const distance = await page.locator('.chat-messages')
    .evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(distance).toBeGreaterThan(100)
  expect(Math.abs((await scrollTop(page)) - scrolledUp)).toBeLessThan(30)
  expect(nova.pageErrors).toEqual([])
})

test('组头键盘可操作，展开/收起写入 aria-expanded', async ({ nova }) => {
  const { page } = nova
  enqueueToolTurn(nova, 'KEYBOARD_TURN_DONE')
  await nova.sendPrompt('读取文件')
  await expect(page.getByText('KEYBOARD_TURN_DONE', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  await openProcess(page)

  const group = page.locator('.tool-call-group__header').first()
  await group.focus()
  const before = await group.getAttribute('aria-expanded')
  await page.keyboard.press('Enter')
  await expect(group).not.toHaveAttribute('aria-expanded', before ?? '')
  await page.keyboard.press('Space')
  await expect(group).toHaveAttribute('aria-expanded', before ?? '')
})

test('点击分页读取的文件会打开预览并定位到本次读取片段', async ({ nova }, testInfo) => {
  const { page } = nova
  const content = Array.from({ length: 120 }, (_, index) => `LINE_${String(index + 1).padStart(3, '0')}`).join('\n')
  await writeFile(path.join(nova.workspacePath, 'paged.txt'), content, 'utf8')
  nova.provider.enqueue(
    { kind: 'tool', name: 'read', arguments: { path: 'paged.txt', offset: 79, limit: 5 }, callId: 'read-paged' },
    { kind: 'text', text: 'PAGED_READ_DONE' }
  )
  await nova.sendPrompt('读取分页片段')
  await expect(page.getByText('PAGED_READ_DONE', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  await openProcess(page)

  await page.locator('.tool-trace-row__file-target').filter({ hasText: 'paged.txt' }).click()
  const preview = page.locator('.inspector-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('.inspector-preview__path')).toHaveText('paged.txt')
  const target = preview.locator('.inspector-preview__line').filter({ hasText: 'LINE_080' })
  await expect(target).toHaveAttribute('data-read-target', 'true')
  await expect(target).toBeInViewport()
  await expect(preview.locator('.inspector-preview__line').filter({ hasText: 'LINE_084' })).toHaveAttribute('data-read-target', 'true')
  await expect(preview.locator('.inspector-preview__line').filter({ hasText: 'LINE_079' })).not.toHaveAttribute('data-read-target', 'true')
  await page.screenshot({ path: testInfo.outputPath('paged-read-preview.png') })
  expect(nova.pageErrors).toEqual([])
})

test('过程行图标与动作对齐，嵌套思考详情呈现独立轻边框', async ({ nova }, testInfo) => {
  const { page } = nova
  const call = (index: number, id: string, name: string, args: Record<string, unknown>) => ({
    payload: { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }
  })
  nova.provider.enqueue(
    {
      kind: 'raw',
      events: [
        { payload: { choices: [{ delta: { reasoning_content: '先读取文件，再核对执行结果。' }, finish_reason: null }] } },
        call(0, 'call_read_layout', 'read', { path: 'e2e-marker.txt' }),
        call(1, 'call_bash_layout', 'bash', { command: 'node -e "console.log(1)"' }),
        { payload: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }
      ]
    },
    { kind: 'text', text: 'PROCESS_LAYOUT_DONE' }
  )
  await nova.sendPrompt('检查过程行布局')
  await expect(page.getByText('PROCESS_LAYOUT_DONE', { exact: true })).toBeVisible()
  await nova.waitUntilIdle()
  await openProcess(page)
  const group = page.locator('.tool-call-group__header').first()
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()

  const xOf = (selector: string) => page.locator(selector).first().evaluate(el => el.getBoundingClientRect().x)
  const thinkingIconX = await xOf('.thinking-block__icon-slot')
  const thinkingTitleX = await xOf('.thinking-block__title')
  for (const selector of ['.tool-call-group__item-icon-slot', '.tool-trace-row__icon-slot']) {
    expect(Math.abs((await xOf(selector)) - thinkingIconX)).toBeLessThanOrEqual(1)
  }
  for (const selector of ['.tool-call-group__item-action', '.tool-trace-row__action']) {
    expect(Math.abs((await xOf(selector)) - thinkingTitleX)).toBeLessThanOrEqual(1)
  }

  const frameProbe = page.evaluate(() => new Promise<number[]>(resolve => {
    const samples: number[] = []
    let previous = performance.now()
    const sample = (now: number): void => {
      samples.push(now - previous)
      previous = now
      if (samples.length >= 60) {
        resolve(samples)
        return
      }
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
  await page.locator('.thinking-block__summary').click()
  const content = page.locator('.thinking-block__content')
  await expect(content).toBeVisible()
  await expect(content).toHaveCSS('border-top-style', 'solid')
  await expect(content).toHaveCSS('border-left-style', 'solid')
  await expect.poll(() => page.locator('.thinking-block__collapsible-shell').evaluate(el =>
    el.getAnimations().every(animation => animation.playState === 'finished')
  )).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('nested-thinking-frame.png') })
  const frameSamples = (await frameProbe).sort((left, right) => left - right)
  const p95FrameMs = frameSamples[Math.ceil(frameSamples.length * 0.95) - 1] ?? 0
  const maxFrameMs = frameSamples.at(-1) ?? 0
  expect(p95FrameMs).toBeLessThan(100)
  expect(maxFrameMs).toBeLessThan(250)
  console.info(`[nested-thinking-performance] p95FrameMs=${p95FrameMs} maxFrameMs=${maxFrameMs}`)
  await testInfo.attach('nested-thinking-performance.json', {
    body: Buffer.from(JSON.stringify({ p95FrameMs, maxFrameMs }, null, 2)),
    contentType: 'application/json'
  })
  expect(nova.pageErrors).toEqual([])
})
