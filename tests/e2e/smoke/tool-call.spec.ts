import { expect, test } from '../fixtures/nova'

test('工具调用经过真实 runtime 执行并把结果回灌给下一轮模型请求', async ({ nova }) => {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'ls',
      arguments: { path: '.' },
      callId: 'call_ls_e2e'
    },
    {
      kind: 'text',
      text: 'NOVA_E2E_TOOL_OK'
    }
  )

  await nova.sendPrompt('列出当前目录后告诉我结果')
  await nova.provider.waitForRequestCount(2)
  await expect(nova.page.getByText('NOVA_E2E_TOOL_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  const secondRequest = JSON.stringify(nova.provider.requests[1]?.body ?? {})
  expect(secondRequest).toContain('e2e-marker.txt')
  expect(secondRequest).toContain('tool')
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
