import { expect, test } from '@playwright/test'
import { launchNova, packagedExecutablePath } from '../fixtures/nova'
import { CODEINDEX_GET_STATUS } from '../../../src/shared/ipc/channels'

function hasCodeContextTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) return false
  return tools.some((tool) => {
    if (typeof tool !== 'object' || tool === null) return false
    const fn = 'function' in tool ? tool.function : undefined
    if (typeof fn !== 'object' || fn === null) return false
    return 'name' in fn && fn.name === 'code_context'
  })
}

function toolMessageContent(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    if (!('role' in message) || !('content' in message)) continue
    if (message.role === 'tool' && typeof message.content === 'string') {
      return message.content
    }
  }
  return null
}

test('Windows unpacked release 启动后可完成一条真实聊天链路', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'packaged release gate runs on Windows')

  const nova = await launchNova(testInfo, { executablePath: packagedExecutablePath() })

  try {
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_PACKAGED_OK' })
    await nova.sendPrompt('验证打包后的 Nova')
    await expect(nova.page.getByText('NOVA_E2E_PACKAGED_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    expect(hasCodeContextTool(nova.provider.requests[0]?.body.tools)).toBe(false)
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

test('Windows unpacked release 能加载索引 Worker 并完成一次查询', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'packaged release gate runs on Windows')

  const nova = await launchNova(testInfo, {
    executablePath: packagedExecutablePath(),
    codeIndexEnabled: true,
    codeFileCount: 24
  })

  try {
    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).status
    , { timeout: 60_000 }).toBe('ready')
    const status = await nova.invoke(CODEINDEX_GET_STATUS)
    expect(status.revision).toBeGreaterThan(0)
    expect(status.coverage.indexedFiles).toBeGreaterThan(0)

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'code_context',
        arguments: { query: 'indexedSymbol1', intent: 'locate' }
      },
      { kind: 'text', text: 'NOVA_E2E_PACKAGED_CODE_INDEX_OK' }
    )
    await nova.sendPrompt('验证打包后的代码索引')
    await expect(nova.page.getByText('NOVA_E2E_PACKAGED_CODE_INDEX_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    expect(hasCodeContextTool(nova.provider.requests[0]?.body.tools)).toBe(true)
    const toolContent = toolMessageContent(nova.provider.requests[1]?.body.messages)
    expect(toolContent).toContain('"status":"ready"')
    expect(toolContent).toContain('module-1.ts')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
