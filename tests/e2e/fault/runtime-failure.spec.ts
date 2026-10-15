import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'

test('provider 失败后 run 明确失败且用户可以继续输入', async ({ nova }) => {
  nova.provider.enqueue({
    kind: 'error',
    status: 400,
    body: { error: { message: 'NOVA_E2E_PROVIDER_FAILURE' } }
  })

  await nova.sendPrompt('触发可控 provider 失败')

  await expect.poll(async () => (await nova.getRunSnapshot())?.status, { timeout: 15_000 }).toBe('failed')
  await nova.waitUntilIdle()
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})

test('中途断流后自动重放，整轮正常完成且半截正文不残留', async ({ nova }) => {
  nova.provider.enqueue(
    { kind: 'drop', chunks: ['NOVA_E2E_PARTIAL_'] },
    { kind: 'text', text: 'NOVA_E2E_REPLAY_OK' }
  )

  await nova.sendPrompt('触发中途断流')

  await expect.poll(async () => (await nova.getRunSnapshot())?.status, { timeout: 20_000 }).toBe('completed')
  await nova.waitUntilIdle()
  expect(nova.provider.requests).toHaveLength(2)
  await expect(nova.page.getByText('NOVA_E2E_REPLAY_OK', { exact: false })).toHaveCount(1)
  await expect(nova.page.getByText('NOVA_E2E_PARTIAL_', { exact: false })).toHaveCount(0)
  await expect(nova.page.getByLabel('消息输入')).toBeEditable()
})

test('150 轮不同工具调用保持进展并正常结束，不在 100 轮停止', async ({ nova }) => {
  test.setTimeout(90_000)
  const turns = Array.from({ length: 150 }, (_, index) => ({
    kind: 'tool' as const,
    name: 'read',
    arguments: { path: `progress-${index}.txt` },
    callId: `progress-${index}`
  }))
  await Promise.all(turns.map((turn, index) => writeFile(path.join(nova.workspacePath, turn.arguments.path), `Progress ${index}\n`, 'utf8')))
  nova.provider.enqueue(...turns, { kind: 'text', text: 'NOVA_LONG_TASK_COMPLETE' })
  await nova.sendPrompt('按顺序读取 150 个进度文件后报告完成')
  await expect.poll(async () => (await nova.getRunSnapshot())?.status, { timeout: 60_000 }).toBe('completed')
  expect((await nova.getRunSnapshot())?.incompleteReason).toBeUndefined()
  expect(nova.provider.requests).toHaveLength(151)
  await expect(nova.page.getByText('NOVA_LONG_TASK_COMPLETE', { exact: false })).toBeVisible()
  await expect(nova.page.locator('.ask-question-panel')).toHaveCount(0)
  await nova.waitUntilIdle()
})

for (const choice of ['换个思路继续', '继续，本轮不再提醒', '停止'] as const) {
  test(`重复工具调用先自救再等待用户，选择「${choice}」后遵守裁决`, async ({ nova }, testInfo) => {
    const count = choice === '继续，本轮不再提醒' ? 15 : 7
    nova.provider.enqueue(
      ...Array.from({ length: count }, (_, index) => ({
        kind: 'tool' as const, name: 'read', arguments: { path: 'e2e-marker.txt' }, callId: `repeat-${index}`
      })),
      { kind: 'text', text: 'NOVA_ADJUDICATED_COMPLETE' }
    )
    await nova.sendPrompt('读取标记文件并检查循环保护')
    const panel = nova.page.locator('.ask-question-panel')
    await expect(panel).toContainText('循环检测')
    expect((await nova.getRunSnapshot())?.status).toBe('waiting_user')
    expect(nova.provider.requests).toHaveLength(7)
    await panel.getByRole('radio', { name: new RegExp(choice) }).check()
    await nova.page.screenshot({ path: testInfo.outputPath('loop-adjudication.png') })
    await panel.getByRole('button', { name: '提交答案', exact: true }).click()
    await nova.waitUntilIdle()
    const snapshot = await nova.getRunSnapshot()
    expect(snapshot?.status).toBe('completed')
    if (choice === '停止') {
      expect(snapshot?.incompleteReason).toBe('no_progress')
      expect(nova.provider.requests).toHaveLength(7)
      await expect(nova.page.getByText('NOVA_ADJUDICATED_COMPLETE', { exact: false })).toHaveCount(0)
    } else {
      expect(snapshot?.incompleteReason).toBeUndefined()
      await expect(nova.page.getByText('NOVA_ADJUDICATED_COMPLETE', { exact: false })).toBeVisible()
      expect(nova.provider.requests).toHaveLength(count + 1)
    }
    expect(nova.pageErrors).toEqual([])
  })
}
