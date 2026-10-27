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

test('交错工具分片重复携带 id 时名称和参数保留，结果按调用身份回灌', async ({ nova }) => {
  const deltas = [
    { index: 0, id: 'call_ls_repeat', function: { name: 'ls', arguments: '{"path":' } },
    { index: 1, id: 'call_read_repeat', function: { name: 're', arguments: '{"path":"e2e-' } },
    { index: 0, id: 'call_ls_repeat', function: { name: '', arguments: '"."}' } },
    { index: 1, id: 'call_read_repeat', function: { name: 'ad', arguments: 'marker.txt"}' } },
    { index: 0, id: 'call_ls_repeat', function: { name: '', arguments: '' } }
  ]
  nova.provider.enqueue(
    {
      kind: 'raw',
      events: [
        ...deltas.map(delta => ({ payload: { choices: [{ delta: { tool_calls: [delta] }, finish_reason: null }] } })),
        { payload: { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } }
      ]
    },
    { kind: 'text', text: 'NOVA_FRAGMENTED_TOOLS_OK' }
  )

  await nova.sendPrompt('列出当前目录并读取标记文件')
  await expect(nova.page.getByText('NOVA_FRAGMENTED_TOOLS_OK', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()

  expect(nova.provider.requests).toHaveLength(2)
  expect(nova.provider.requests[1]?.body.messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ role: 'assistant', tool_calls: expect.arrayContaining([
      { id: 'call_ls_repeat', type: 'function', function: { name: 'ls', arguments: '{"path":"."}' } },
      { id: 'call_read_repeat', type: 'function', function: { name: 'read', arguments: '{"path":"e2e-marker.txt"}' } }
    ]) }),
    expect.objectContaining({ role: 'tool', tool_call_id: 'call_ls_repeat', content: expect.stringContaining('e2e-marker.txt') }),
    expect.objectContaining({ role: 'tool', tool_call_id: 'call_read_repeat', content: expect.stringContaining('Nova Electron E2E marker') })
  ]))
  await expect(nova.page.getByText('不可用：未注册工具', { exact: false })).toHaveCount(0)
  expect((await nova.getRunSnapshot())?.status).toBe('completed')
  expect(nova.pageErrors).toEqual([])
})
