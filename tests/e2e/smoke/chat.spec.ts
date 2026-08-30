import { expect, test } from '../fixtures/nova'

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

test('拖拽 Inspector 期间聊天阅读宽度冻结，松手后恢复响应式并提交一次', async ({ nova }) => {
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

  await page.getByRole('button', { name: '审查与文件面板' }).click()
  const handle = page.locator('.inspector-panel__resize')
  await handle.waitFor({ state: 'visible' })
  // 开合动画走 transform，动画中 boundingBox 是中间位置；等 transform 归零再取拖拽坐标
  await expect(page.locator('.inspector-panel')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('inspector resize handle not visible')

  const readWidths = () =>
    page.evaluate((sels: string[]) => sels.map(sel => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect().width : -1
    }), [...READING_WIDTH_SELECTORS])

  const beforeDrag = await readWidths()
  const startX = handleBox.x + handleBox.width / 2
  const y = handleBox.y + 300

  await page.mouse.move(startX, y)
  await page.mouse.down()
  const dragSamples: number[][] = []
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(startX - step * 15, y, { steps: 2 })
    dragSamples.push(await readWidths())
  }

  // 拖拽中：阅读柱 / 虚拟列表父容器 / Composer 宽度冻结在拖拽开始时的值
  const labels = ['消息阅读柱', '虚拟列表父容器', 'Composer']
  dragSamples[0].forEach((_, idx) => {
    const spread = Math.max(...dragSamples.map(s => s[idx])) - Math.min(...dragSamples.map(s => s[idx]))
    expect(
      spread,
      `拖拽中${labels[idx]}宽度逐帧变化: ${dragSamples.map(s => s[idx]).join(' → ')}`
    ).toBeLessThanOrEqual(1)
  })

  await page.mouse.up()

  // 松手：面板宽度提交后主区恢复响应式，阅读柱跟随变窄
  const afterDrag = await readWidths()
  expect(afterDrag[0]).toBeLessThan(beforeDrag[0])
  expect(afterDrag[2]).toBeLessThan(beforeDrag[2])

  const storedWidth = await page.evaluate(() =>
    Number(window.localStorage.getItem('nova.layout.inspectorWidth'))
  )
  expect(storedWidth).toBeGreaterThan(420)
  expect(nova.pageErrors).toEqual([])
})

test('流式输出期间拖拽 Inspector：自动跟底保持，用户上滚不被强制回底', async ({ nova }) => {
  const { page, app } = nova

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
  nova.provider.enqueue({ kind: 'hold', id: 'stream-drag-1', text: COMPLEX_REPLY })
  await nova.sendPrompt('输出固定长文')
  await page.locator('.chat-messages__tail-status').waitFor({ state: 'visible' })

  await page.getByRole('button', { name: '审查与文件面板' }).click()
  const handle = page.locator('.inspector-panel__resize')
  await handle.waitFor({ state: 'visible' })
  await expect(page.locator('.inspector-panel')).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)')
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
  nova.provider.release('stream-drag-1')
  await nova.waitUntilIdle()
  expect(await distanceFromBottom()).toBeLessThan(120)

  // 第二轮：流式输出中用户上滚 → 拖拽不强制回底
  nova.provider.enqueue({ kind: 'hold', id: 'stream-drag-2', text: COMPLEX_REPLY })
  await nova.sendPrompt('再输出一次')
  await page.locator('.chat-messages__tail-status').waitFor({ state: 'visible' })
  await page.waitForTimeout(200)

  const scrollContainer = page.locator('.chat-messages')
  const distanceBeforeScrollUp = await distanceFromBottom()
  await scrollContainer.evaluate(el => {
    el.scrollTop = 0
  })
  // 触发一次滚动同步，让自动滚动模式进入用户上滚态
  await page.waitForTimeout(300)
  expect(await distanceFromBottom()).toBeGreaterThan(distanceBeforeScrollUp)

  const handleBox2 = await handle.boundingBox()
  const startX2 = handleBox2!.x + handleBox2!.width / 2
  await page.mouse.move(startX2, y)
  await page.mouse.down()
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(startX2 + step * 12, y, { steps: 2 })
    await page.waitForTimeout(60)
  }
  await page.mouse.up()
  nova.provider.release('stream-drag-2')
  await nova.waitUntilIdle()

  // 上滚位置不被强制拉回底部
  expect(await distanceFromBottom()).toBeGreaterThan(400)
  expect(nova.pageErrors).toEqual([])
  expect(nova.rendererConsole.some(line => line.includes('ResizeObserver loop'))).toBe(false)
})
