import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/nova'

/** 等右侧面板开合的宽度过渡播完：动画中面板位置是中间值，不能用来取拖拽坐标。 */
async function waitForInspectorSettled(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const panel = document.querySelector('.inspector-panel')
    return panel !== null && panel.getBoundingClientRect().width > 0 && panel.getAnimations().length === 0
  })
}

test('用户发送消息后完成真实 Electron 聊天链路并恢复可输入状态', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'text',
    text: 'NOVA_E2E_CHAT_OK',
    chunks: ['NOVA_', 'E2E_', 'CHAT_', 'OK']
  })

  await nova.sendPrompt('回复固定标记即可')
  await expect(nova.page.getByText('NOVA_E2E_CHAT_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const snapshot = await nova.getRunSnapshot()
  expect(snapshot?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})

/** 复杂消息样本：多段长文本 + 代码块，保证阅读柱内有稳定的断行与行高测量工作量 */
const COMPLEX_REPLY = [
  ...Array.from({ length: 8 }, (_, i) =>
    `第 ${i + 1} 段：右侧面板调宽时聊天主区被压缩，所有可见消息需要重新断行，` +
    '动态高度虚拟列表随之重新测量行高，形成二次布局与绘制。'
  ),
  '',
  '```ts',
  ...Array.from({ length: 24 }, (_, i) => [
    `export function helper${i}(value: number): number {`,
    `  return value * ${i + 1} + ${i};`,
    '}'
  ]).flat(),
  '```'
].join('\n')

const READING_WIDTH_SELECTORS = [
  '.chat-messages__flow-inner',
  '.chat-messages__virtual',
  '.chat-panel__composer-inner'
] as const

test('拖拽与开合 Inspector 及 Sidebar 期间主区阅读列与面板内容实时平滑伸缩，松手无跳变且持久化一次', async ({ nova }) => {
  const { page, app } = nova

  // 固定窗口几何，保证拖拽前后阅读柱宽度可直接比较
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    win?.setBounds({ x: 60, y: 60, width: 1280, height: 800 })
  })

  nova.provider.enqueue({ kind: 'text', text: COMPLEX_REPLY })
  await nova.sendPrompt('输出固定长文')
  await expect(page.getByText('第 1 段', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  await page.getByRole('button', { name: '审阅、文件与浏览面板' }).click()
  const handle = page.locator('.inspector-panel__resize')
  await handle.waitFor({ state: 'visible' })
  // 开合动画走宽度过渡，动画中 boundingBox 是中间位置；等过渡播完再取拖拽坐标
  await waitForInspectorSettled(page)
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('inspector resize handle not visible')

  const readWidths = () =>
    page.evaluate((sels: string[]) => sels.map(sel => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect().width : -1
    }), [...READING_WIDTH_SELECTORS])
  const readInnerWidth = (selector: string) =>
    page.evaluate((sel: string) => {
      const el = document.querySelector<HTMLElement>(sel)
      return el ? el.getBoundingClientRect().width : -1
    }, selector)

  const beforeDrag = await readWidths()
  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + 300

  await page.mouse.move(startX, y)
  await page.mouse.down()
  const dragSamples: number[][] = []
  const inspectorInnerSamples: number[] = []
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(startX - step * 15, y, { steps: 2 })
    dragSamples.push(await readWidths())
    inspectorInnerSamples.push(await readInnerWidth('.inspector-panel__inner'))
  }

  // 拖拽中：主聊天阅读列 / 虚拟列表父容器 / Composer 与面板内层容器均实时平滑伸缩跟随，
  // 不锁死在初始帧等待松手才跳变
  const labels = ['消息阅读柱', '虚拟列表父容器', 'Composer']
  dragSamples[0].forEach((_, idx) => {
    const distinctChatWidths = new Set(dragSamples.map(s => Math.round(s[idx])))
    expect(
      distinctChatWidths.size,
      `拖拽中${labels[idx]}应实时动态伸缩: ${dragSamples.map(s => Math.round(s[idx])).join(' → ')}`
    ).toBeGreaterThanOrEqual(5)
    expect(dragSamples.at(-1)![idx]).toBeLessThan(beforeDrag[idx] - 100)
  })
  const distinctInspectorInnerWidths = new Set(inspectorInnerSamples.map(w => Math.round(w)))
  expect(distinctInspectorInnerWidths.size).toBeGreaterThanOrEqual(5)
  expect(inspectorInnerSamples.at(-1)!).toBeGreaterThan(420)

  await page.mouse.up()

  // 松手：阅读列已经在拖拽末帧到达目标宽度，松手瞬间无跳变
  const afterDrag = await readWidths()
  expect(afterDrag[0]).toBeLessThan(beforeDrag[0])
  expect(afterDrag[2]).toBeLessThan(beforeDrag[2])
  expect(Math.abs(afterDrag[0] - dragSamples.at(-1)![0])).toBeLessThanOrEqual(2)
  expect(Math.abs(afterDrag[2] - dragSamples.at(-1)![2])).toBeLessThanOrEqual(2)

  const storedWidth = await page.evaluate(() =>
    Number(window.localStorage.getItem('nova.layout.inspectorWidth'))
  )
  expect(storedWidth).toBeGreaterThan(420)

  // 拖拽左侧 Sidebar：同样实时平滑挤压主区阅读列与侧栏内层文字，松手无跳变
  const sidebarHandle = page.locator('.sidebar-shell__resize-handle')
  const sidebarBox = await sidebarHandle.boundingBox()
  if (!sidebarBox) throw new Error('sidebar resize handle not visible')
  const sbStartX = sidebarBox.x + sidebarBox.width / 2
  await page.mouse.move(sbStartX, y)
  await page.mouse.down()
  const sbChatSamples: number[][] = []
  const sbInnerSamples: number[] = []
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(sbStartX + step * 12, y, { steps: 2 })
    sbChatSamples.push(await readWidths())
    sbInnerSamples.push(await readInnerWidth('.sidebar-shell__inner'))
  }
  sbChatSamples[0].forEach((_, idx) => {
    expect(new Set(sbChatSamples.map(s => Math.round(s[idx]))).size).toBeGreaterThanOrEqual(4)
  })
  expect(new Set(sbInnerSamples.map(w => Math.round(w))).size).toBeGreaterThanOrEqual(4)
  await page.mouse.up()
  const afterSbDrag = await readWidths()
  expect(Math.abs(afterSbDrag[0] - sbChatSamples.at(-1)![0])).toBeLessThanOrEqual(2)

  // 点击折叠与展开左侧 Sidebar：主区阅读列在 250ms 过渡中逐帧平滑放大填充与收缩挤压，不发生单帧跳变
  const sidebarSlideMotion = await page.evaluate(async () => {
    const shell = document.querySelector<HTMLElement>('.sidebar-shell')!
    const flow = document.querySelector<HTMLElement>('.chat-messages__flow-inner')!
    const collapseBtn = document.querySelector<HTMLButtonElement>('button[aria-label="折叠会话导航"]')!
    const collapseWidths: number[] = [Math.round(flow.getBoundingClientRect().width)]
    collapseBtn.click()
    const t0 = performance.now()
    while (performance.now() - t0 < 1000) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      collapseWidths.push(Math.round(flow.getBoundingClientRect().width))
      if (shell.getAnimations().length === 0 && shell.getBoundingClientRect().width < 1) break
    }
    const expandBtn = document.querySelector<HTMLButtonElement>('button[aria-label="展开会话导航"]')!
    const expandWidths: number[] = [Math.round(flow.getBoundingClientRect().width)]
    expandBtn.click()
    const t1 = performance.now()
    while (performance.now() - t1 < 1000) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      expandWidths.push(Math.round(flow.getBoundingClientRect().width))
      if (shell.getAnimations().length === 0 && shell.getBoundingClientRect().width > 200) break
    }
    return {
      collapseDistinct: new Set(collapseWidths).size,
      expandDistinct: new Set(expandWidths).size,
      collapseStart: collapseWidths[0],
      collapseEnd: collapseWidths.at(-1)!
    }
  })
  expect(sidebarSlideMotion.collapseDistinct).toBeGreaterThanOrEqual(4)
  expect(sidebarSlideMotion.expandDistinct).toBeGreaterThanOrEqual(4)
  expect(sidebarSlideMotion.collapseEnd).toBeGreaterThan(sidebarSlideMotion.collapseStart + 100)

  expect(nova.pageErrors).toEqual([])
})

test('流式输出期间拖拽 Inspector：自动跟底保持，用户上滚不被强制回底', async ({ nova }) => {
  const { page, app } = nova

  const streamChunks = Array.from(
    { length: 36 },
    (_, index) => `流式第 ${index + 1} 段：${'内容 '.repeat(45)}\n`
  )
  const enqueueStreamingReply = () => {
    nova.provider.enqueue({
      kind: 'text',
      text: streamChunks.join(''),
      chunks: streamChunks,
      chunkDelayMs: 50
    })
  }

  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
    win?.setBounds({ x: 60, y: 60, width: 1280, height: 800 })
  })

  const distanceFromBottom = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.chat-messages')
      if (!el) return -1
      return el.scrollHeight - el.scrollTop - el.clientHeight
    })

  // 第一轮：流式输出 + 拖拽 → 自动跟底保持
  enqueueStreamingReply()
  await nova.sendPrompt('输出固定长文')
  await page.locator('.chat-messages__tail-status').waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '审阅、文件与浏览面板' }).click()
  const handle = page.locator('.inspector-panel__resize')
  await handle.waitFor({ state: 'visible' })
  await waitForInspectorSettled(page)
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('inspector resize handle not visible')
  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + 300

  await page.mouse.move(startX, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(startX - step * 12, y, { steps: 2 })
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await nova.waitUntilIdle()
  expect(await distanceFromBottom()).toBeLessThan(120)

  // 第二轮：流式输出中用户上滚 → 拖拽不强制回底
  enqueueStreamingReply()
  await nova.sendPrompt('再输出一次')
  await page.locator('.chat-messages__tail-status').waitFor({ state: 'visible' })

  const scrollContainer = page.locator('.chat-messages')
  await expect.poll(async () => scrollContainer.evaluate(el => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(500)
  await scrollContainer.hover()
  await page.mouse.wheel(0, -1200)
  await expect.poll(distanceFromBottom).toBeGreaterThan(400)

  const handleBox2 = await handle.boundingBox()
  const startX2 = handleBox2!.x + handleBox2!.width / 2
  await page.mouse.move(startX2, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(startX2 + step * 12, y, { steps: 2 })
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  await nova.waitUntilIdle()

  // 上滚位置不被强制拉回底部
  expect(await distanceFromBottom()).toBeGreaterThan(400)
  expect(nova.pageErrors).toEqual([])
  expect(nova.rendererConsole.some(line => line.includes('ResizeObserver loop'))).toBe(false)
})
