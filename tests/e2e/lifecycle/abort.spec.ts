import { expect, test } from '../fixtures/nova'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

test('流式请求中止后 run 进入终态且输入区恢复', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'hold',
    id: 'abort-run',
    text: 'SHOULD_NOT_RENDER'
  })

  await nova.sendPrompt('保持运行直到我停止')
  await expect(nova.page.getByRole('button', { name: '中断生成' })).toBeVisible()

  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.provider.waitForAbortCount(1, 10_000)
  await nova.waitUntilIdle()

  await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
  await expect(nova.page.getByText('上次任务异常中断', { exact: false })).toHaveCount(0)
  await expect(nova.page.locator('.chat-messages__interruption')).toHaveCount(0)
  await expect(nova.page.getByText('SHOULD_NOT_RENDER', { exact: false })).toHaveCount(0)
  nova.provider.enqueue({ kind: 'text', text: 'CANCEL_RECOVERY_OK' })
  await nova.sendPrompt('继续对话')
  await nova.waitUntilIdle()
  await expect(nova.page.getByText('CANCEL_RECOVERY_OK', { exact: false })).toBeVisible()
  await expect(nova.page.getByText('SHOULD_NOT_RENDER', { exact: false })).toHaveCount(0)
})

test('停止保留文件成果和已展开的工具详情，重载后仍可直接查看过程并继续对话', async ({ nova }, testInfo) => {
  nova.provider.enqueue(
    { kind: 'tool', name: 'write', arguments: { path: 'stop-result.txt', content: 'PRESERVED_RESULT' }, callId: 'stop-write' },
    { kind: 'hold', id: 'stop-after-write', text: 'SHOULD_NOT_RENDER' }
  )
  await nova.sendPrompt('先写入文件，再等待我的指示')
  await nova.provider.waitForRequestCount(2)
  const row = nova.page.locator('.tool-trace-row').filter({ hasText: 'stop-result.txt' })
  const detailToggle = row.locator('.tool-trace-row__header')
  await detailToggle.click()
  await expect(detailToggle).toHaveAttribute('aria-expanded', 'true')
  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.provider.waitForAbortCount(1)
  await nova.waitUntilIdle()
  await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
  await expect(row).toBeVisible()
  await expect(detailToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(nova.page.getByTestId('turn-process-header')).toHaveAttribute('aria-expanded', 'true')
  await expect(nova.page.getByText('已停止', { exact: false })).toHaveCount(0)
  await expect(nova.page.locator('.chat-messages__interruption')).toHaveCount(0)
  await expect(nova.page.locator('.chat-cross-turn-notice')).toHaveCount(0)
  await expect(nova.page.locator('.tool-trace-row--live')).toHaveCount(0)
  expect(await readFile(path.join(nova.workspacePath, 'stop-result.txt'), 'utf8')).toBe('PRESERVED_RESULT')
  await nova.page.screenshot({ path: testInfo.outputPath('stopped-expanded.png') })

  await nova.page.reload()
  await expect(row).toBeVisible()
  await expect(nova.page.getByTestId('turn-process-header')).toHaveAttribute('aria-expanded', 'true')
  await expect(nova.page.locator('.chat-messages__interruption')).toHaveCount(0)
  nova.provider.enqueue({ kind: 'text', text: 'CONTINUE_AFTER_STOP_OK' })
  await nova.sendPrompt('继续')
  await nova.waitUntilIdle()
  await expect(nova.page.getByText('CONTINUE_AFTER_STOP_OK', { exact: false })).toBeVisible()
  await expect(row).toBeVisible()
  expect(nova.pageErrors).toEqual([])
})

test('工具执行中停止会结束真实进程并保留工具记录，不把取消渲染成异常恢复', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'tool', name: 'bash', callId: 'stop-running-command',
    arguments: { command: 'node -e "setTimeout(() => {}, 60000)"' }
  })
  await nova.sendPrompt('运行命令，等待我停止')
  await expect.poll(async () => (await nova.getRunSnapshot())?.toolCommits?.find(
    step => step.toolCallId === 'stop-running-command'
  )?.phase).toBe('executing')
  await nova.page.getByRole('button', { name: '中断生成' }).click()
  await nova.waitUntilIdle()
  await expect.poll(async () => (await nova.getRunSnapshot())?.status).toBe('cancelled')
  await expect(nova.page.locator('.tool-trace-row').filter({ hasText: 'setTimeout' })).toBeVisible()
  await expect(nova.page.locator('.tool-trace-row--live')).toHaveCount(0)
  await expect(nova.page.locator('.chat-messages__interruption')).toHaveCount(0)
  await expect(nova.page.getByText('已停止', { exact: false })).toHaveCount(0)
  nova.provider.enqueue({ kind: 'text', text: 'AFTER_TOOL_CANCEL_OK' })
  await nova.sendPrompt('继续对话')
  await nova.waitUntilIdle()
  await expect(nova.page.getByText('AFTER_TOOL_CANCEL_OK', { exact: false })).toBeVisible()
  expect(nova.pageErrors).toEqual([])
})
