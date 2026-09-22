import { expect, test } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { launchNova, packagedExecutablePath } from '../fixtures/nova'
import { BROWSER_CLOSE, BROWSER_OPEN, CODEINDEX_GET_STATUS, WORKSPACE_SET_PERMISSION_MODE } from '../../../src/shared/ipc/channels'

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

test('Windows unpacked release 的内置网页不带应用桥，关掉后页面进程消失', async ({}, testInfo) => {
  test.skip(process.platform !== 'win32', 'packaged release gate runs on Windows')
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>packed</title><body><p>packed</p></body>')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const nova = await launchNova(testInfo, { executablePath: packagedExecutablePath() })
  try {
    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()
    await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url: `${origin}/` })
    expect(opened.status).toBe('applied')
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(1)
    const isolation = await nova.app.evaluate(async ({ webContents }) => {
      const guest = webContents.getAllWebContents().find((item) => {
        try {
          return item.getType() === 'webview' && !item.isDestroyed()
        } catch {
          return false
        }
      })
      if (!guest) return null
      const probe = await guest.executeJavaScript(`({
        api: typeof window.api,
        nodeProcess: typeof process,
        protocol: location.protocol
      })`)
      return { type: guest.getType(), ...probe }
    })
    expect(isolation).toMatchObject({
      type: 'webview',
      api: 'undefined',
      nodeProcess: 'undefined',
      protocol: 'http:'
    })
    if (opened.status === 'applied') {
      await nova.invoke(BROWSER_CLOSE, { sessionId, browserId: opened.page.browserId })
    }
    await expect(nova.page.locator('webview[data-browser-id]')).toHaveCount(0)
    const guestsLeft = await nova.app.evaluate(({ webContents }) => {
      return webContents.getAllWebContents().filter((item) => {
        try {
          return item.getType() === 'webview' && !item.isDestroyed()
        } catch {
          return false
        }
      }).length
    })
    expect(guestsLeft).toBe(0)
    // 卸旧 webview 时 Electron 44.4.3 会抛 Invalid guestInstanceId，不是应用桥泄漏
    expect(
      nova.pageErrors.filter((error) => !error.includes('Invalid guestInstanceId'))
    ).toEqual([])
  } finally {
    await nova.cleanup()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
})
