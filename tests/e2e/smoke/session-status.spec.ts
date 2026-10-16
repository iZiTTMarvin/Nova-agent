import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../fixtures/nova'
import { SETTINGS_SET } from '../../../src/shared/ipc/channels'

const capsule = '.session-status-rail:not(.session-status-rail--inspector) .session-status'

test('统一状态：独立右侧、双主题、轮次审阅回退与侧栏互斥', async ({ nova }, info) => {
  await nova.page.setViewportSize({ width: 1600, height: 1000 })
  const session = await nova.createSession('default')
  const sessionId = session.currentSessionId!
  await expect(nova.page.locator(capsule)).toHaveCount(0)
  await nova.page.screenshot({ path: info.outputPath('status-empty.png') })
  expect(await nova.page.evaluate(() => {
    const chat = document.querySelector('.chat-workspace > .chat-panel')!.getBoundingClientRect()
    return document.querySelector('.chat-workspace')!.getBoundingClientRect().right - chat.right
  })).toBeLessThan(2)
  nova.provider.enqueue(
    { kind: 'tool', name: 'todo_write', arguments: { todos: [{ content: '整理显示入口', status: 'in_progress', priority: 'medium' }, { content: '检查联动', status: 'pending', priority: 'medium' }] } },
    { kind: 'tool', name: 'write', arguments: { path: 'e2e-marker.txt', content: 'Updated by status test\n' } },
    { kind: 'tool', name: 'todo_write', arguments: { todos: [{ content: '整理显示入口', status: 'completed', priority: 'medium' }, { content: '检查联动', status: 'completed', priority: 'medium' }] } },
    { kind: 'text', text: 'STATUS_FIRST_ROUND_COMPLETE' }
  )
  await nova.sendPrompt('整理入口并检查联动')
  await nova.waitUntilIdle()
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'true')
  await expect(nova.page.locator(capsule).getByLabel('任务清单')).toContainText('2/2')
  await expect(nova.page.locator(capsule).locator('[data-status="completed"]')).toHaveCount(2)
  await expect(nova.page.locator('.todo-dock, .active-background-banner, .xforge-capsule')).toHaveCount(0)
  await expect(nova.page.locator('.chat-messages .diff-viewer')).toHaveCount(0)
  await expect(nova.page.locator(capsule).getByLabel('文件改动')).toContainText('e2e-marker.txt')

  const geometry = await nova.page.evaluate(() => {
    const workspace = document.querySelector('.chat-workspace')!.getBoundingClientRect()
    const chat = document.querySelector('.chat-workspace > .chat-panel')!.getBoundingClientRect()
    const panel = document.querySelector('.session-status')!.getBoundingClientRect()
    const composer = document.querySelector('.chat-panel__composer-inner')!.getBoundingClientRect()
    return { workspaceRight: workspace.right, chatRight: chat.right, panelLeft: panel.left, composerRight: composer.right }
  })
  expect(Math.abs(geometry.workspaceRight - geometry.chatRight)).toBeLessThan(2)
  expect(geometry.panelLeft).toBeGreaterThan(geometry.composerRight)

  for (const theme of ['dark', 'light'] as const) {
    await nova.invoke(SETTINGS_SET, { theme })
    await nova.page.reload()
    await expect(nova.page.locator(capsule).getByLabel('文件改动')).toContainText('e2e-marker.txt')
    await expect(nova.page.locator(capsule)).toHaveCSS('backdrop-filter', 'blur(16px) saturate(1.2)')
    await expect.poll(() => nova.page.locator(capsule).evaluate(panel => {
      const body = panel.querySelector('.session-status__body')!
      const review = panel.querySelector('[aria-label="文件改动"] button:last-child')!
      const bounds = panel.getBoundingClientRect()
      return Math.abs(bounds.height - (44 + Math.min(body.scrollHeight, 490))) < 1
        && review.getBoundingClientRect().bottom <= bounds.bottom - 1
    })).toBe(true)
    await expect.poll(() => nova.page.locator(capsule).evaluate(panel => {
      const lastRow = panel.querySelector('.session-status__body')!.lastElementChild!
      return panel.getBoundingClientRect().bottom - lastRow.getBoundingClientRect().bottom
    })).toBeGreaterThanOrEqual(10)
    await nova.page.screenshot({ path: info.outputPath(`status-${theme}.png`) })
  }

  await nova.page.locator(capsule).getByRole('button', { name: '审阅这轮改动' }).click()
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-tiny', 'true')
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'false')
  await expect(nova.page.getByRole('button', { name: '撤销本轮待审改动' })).toBeVisible()
  await expect(nova.page.locator(capsule)).toHaveCSS('width', '190px')
  await nova.page.screenshot({ path: info.outputPath('status-inspector.png') })

  nova.provider.enqueue(
    { kind: 'tool', name: 'write', arguments: { path: 'second.txt', content: 'second round\n' } },
    { kind: 'text', text: 'STATUS_SECOND_ROUND_COMPLETE' }
  )
  await nova.sendPrompt('再写一个文件')
  await nova.waitUntilIdle()
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'false')
  await expect(nova.page.getByLabel('审阅轮次').locator('option')).toHaveCount(2)
  await nova.page.getByRole('button', { name: '撤销本轮待审改动' }).click()
  await expect.poll(() => readFile(path.join(nova.workspacePath, 'e2e-marker.txt'), 'utf8')).toBe('Nova Electron E2E marker\n')
  expect(await readFile(path.join(nova.workspacePath, 'second.txt'), 'utf8')).toBe('second round\n')
  await nova.page.getByRole('button', { name: '查看会话状态', exact: true }).click()
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'true')

  await nova.page.locator(capsule).getByRole('button', { name: '收起浮窗' }).click()
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'false')
  await nova.page.getByRole('button', { name: '查看会话状态', exact: true }).press('Enter')
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'true')
  await expect(nova.page.locator(capsule)).toHaveCSS('width', '288px')
  const motion = await nova.page.locator(capsule).evaluate(async panel => {
    const widths: number[] = []
    let reversed = false
    const started = performance.now()
    panel.querySelector<HTMLButtonElement>('.session-status__collapse')!.click()
    while (performance.now() - started < 2000) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const width = panel.getBoundingClientRect().width
      widths.push(width)
      if (!reversed && width > 200 && width < 278) {
        panel.querySelector<HTMLButtonElement>('.session-status__trigger')!.click()
        reversed = true
      }
      const moving = panel.getAnimations().some(animation => animation.playState === 'running')
      if (reversed && panel.getAttribute('data-expanded') === 'true' && !moving) break
    }
    return { widths, reversed, sameShell: document.querySelector('.session-status') === panel }
  })
  expect(motion.reversed).toBe(true)
  expect(motion.sameShell).toBe(true)
  expect(motion.widths.some(width => width > 200 && width < 278)).toBe(true)
  expect(motion.widths.every(width => width >= 189 && width <= 289)).toBe(true)
  await expect(nova.page.locator(capsule)).toHaveCSS('width', '288px')
  await nova.page.emulateMedia({ reducedMotion: 'reduce' })
  await expect(nova.page.locator(capsule).locator('.status-sprite__drawing')).toHaveCSS('animation-name', 'none')
  await nova.page.emulateMedia({ reducedMotion: 'no-preference' })

  await nova.page.setViewportSize({ width: 900, height: 700 })
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-tiny', 'true')
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'false')
  await nova.page.getByRole('button', { name: '查看会话状态', exact: true }).click()
  await expect(nova.page.locator('.inspector-panel')).toHaveCSS('opacity', '1')
  await nova.page.screenshot({ path: info.outputPath('status-compact.png') })
  await nova.createSession('default')
  nova.provider.enqueue(
    { kind: 'tool', name: 'todo_write', arguments: { todos: [{ content: '仅有任务的窄窗状态', status: 'pending', priority: 'medium' }] } },
    { kind: 'text', text: 'STATUS_TASK_ONLY_READY' }
  )
  await nova.sendPrompt('建立任务清单')
  await nova.waitUntilIdle()
  await nova.page.getByRole('button', { name: '查看会话状态', exact: true }).click()
  await expect(nova.page.getByLabel('会话状态详情')).toContainText('仅有任务的窄窗状态')
  await expect(nova.page.getByLabel('会话状态详情').getByLabel('任务清单')).toBeVisible()
  await expect(nova.page.locator('.inspector-panel')).toHaveCSS('opacity', '1')
  await expect(nova.page.locator(capsule)).toHaveAttribute('data-expanded', 'false')
  await nova.page.screenshot({ path: info.outputPath('status-task-inspector.png') })
  await nova.createSession('default')
  await expect(nova.page.getByLabel('会话状态详情')).toHaveCount(0)
  await expect(nova.page.getByText('仅有任务的窄窗状态', { exact: true })).toHaveCount(0)
  await nova.selectSession(sessionId)
  expect(nova.pageErrors).toEqual([])
})
