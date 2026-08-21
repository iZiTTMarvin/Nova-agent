import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, launchNova, test } from '../fixtures/nova'
import {
  CODEINDEX_GET_STATUS,
  CODEINDEX_STATUS,
  SAVE_MODEL_CONFIG,
  SETTINGS_SET,
  WORKSPACE_DELETE_SESSION,
  WORKSPACE_SELECT_PROJECT
} from '../../../src/shared/ipc/channels'

test('首次构建不阻断聊天，完成后工具可查询且 reload 恢复状态', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, {
    skipWorkspaceSetup: true,
    codeFileCount: 800
  })

  try {
    await nova.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl,
      apiKey: 'nova-e2e-key',
      modelId: 'nova-e2e-model',
      cacheProfile: 'generic',
      toolDialect: 'native'
    })
    await nova.invoke(SETTINGS_SET, { codeIndexEnabled: true })
    await nova.invoke(WORKSPACE_SELECT_PROJECT, { path: nova.workspacePath })
    // 让 Renderer 读取刚写入的模型配置；索引构建在 Main 中继续，不随 reload 重启。
    await nova.page.reload()
    await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))

    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).status
    ).toBe('building')

    nova.provider.enqueue({ kind: 'text', text: 'NOVA_E2E_BUILDING_CHAT_OK' })
    await nova.sendPrompt('索引构建时继续聊天')
    await expect(
      nova.page.getByText('NOVA_E2E_BUILDING_CHAT_OK', { exact: false })
    ).toBeVisible()
    await nova.waitUntilIdle()

    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).status
    ).toBe('ready')
    const ready = await nova.invoke(CODEINDEX_GET_STATUS)
    expect(ready.coverage.indexedFiles).toBeGreaterThan(0)

    const requestOffset = nova.provider.requests.length
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'code_context',
        arguments: { query: 'indexedSymbol42', intent: 'locate' }
      },
      { kind: 'text', text: 'NOVA_E2E_CODE_CONTEXT_OK' }
    )
    await nova.sendPrompt('查找 indexedSymbol42')
    await nova.provider.waitForRequestCount(requestOffset + 2)
    await expect(
      nova.page.getByText('NOVA_E2E_CODE_CONTEXT_OK', { exact: false })
    ).toBeVisible()
    expect(JSON.stringify(nova.provider.requests[requestOffset + 1]?.body.messages))
      .toContain('module-42.ts')

    const revisionBeforeEdits = ready.revision
    await nova.page.evaluate((channel) => {
      const target = window as typeof window & {
        __codeIndexEvents?: number
        api?: { on: (name: string, listener: () => void) => () => void }
      }
      target.__codeIndexEvents = 0
      target.api?.on(channel, () => {
        target.__codeIndexEvents = (target.__codeIndexEvents ?? 0) + 1
      })
    }, CODEINDEX_STATUS)
    await Promise.all(Array.from({ length: 40 }, (_, index) =>
      writeFile(
        path.join(nova.workspacePath, 'src', `module-${index}.ts`),
        `export function indexedSymbol${index}(): number { return ${index + 1} }\n`,
        'utf8'
      )
    ))
    await expect.poll(async () => {
      const status = await nova.invoke(CODEINDEX_GET_STATUS)
      return status.status === 'ready' && status.revision > revisionBeforeEdits
    }).toBe(true)
    const broadcastCount = await nova.page.evaluate(() =>
      (window as typeof window & { __codeIndexEvents?: number }).__codeIndexEvents ?? 0
    )
    expect(broadcastCount).toBeGreaterThan(0)
    expect(broadcastCount).toBeLessThanOrEqual(6)

    await nova.page.reload()
    await nova.page.waitForFunction(() => Boolean((window as typeof window & { api?: unknown }).api))
    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).status
    ).toBe('ready')
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

test('会话切换跟随工作区，删除最后会话后状态归零', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, {
    codeIndexEnabled: true,
    codeFileCount: 20
  })
  const secondWorkspace = await mkdtemp(path.join(os.tmpdir(), 'nova-e2e-code-index-second-'))

  try {
    const firstState = await nova.getWorkspace()
    const firstSessionId = firstState.currentSessionId
    if (!firstSessionId) throw new Error('first session missing')
    await mkdir(path.join(secondWorkspace, 'src'), { recursive: true })
    await writeFile(
      path.join(secondWorkspace, 'src', 'second-only.ts'),
      'export const secondWorkspaceOnly = 42\n',
      'utf8'
    )

    const secondState = await nova.invoke(WORKSPACE_SELECT_PROJECT, { path: secondWorkspace })
    const secondSessionId = secondState.currentSessionId
    if (!secondSessionId) throw new Error('second session missing')
    await expect.poll(async () => {
      const status = await nova.invoke(CODEINDEX_GET_STATUS)
      return status.workspaceRoot === secondWorkspace && status.status === 'ready'
    }).toBe(true)

    const requestOffset = nova.provider.requests.length
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'code_context',
        arguments: { query: 'secondWorkspaceOnly', intent: 'locate' }
      },
      { kind: 'text', text: 'NOVA_E2E_SECOND_WORKSPACE_OK' }
    )
    await nova.sendPrompt('查找 secondWorkspaceOnly')
    await nova.provider.waitForRequestCount(requestOffset + 2)
    const toolMessages = JSON.stringify(
      nova.provider.requests[requestOffset + 1]?.body.messages
    )
    expect(toolMessages).toContain('second-only.ts')
    expect(toolMessages).not.toContain('module-0.ts')

    await nova.selectSession(firstSessionId)
    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).workspaceRoot
    ).toBe(nova.workspacePath)
    await nova.selectSession(secondSessionId)
    await expect.poll(async () =>
      (await nova.invoke(CODEINDEX_GET_STATUS)).workspaceRoot
    ).toBe(secondWorkspace)

    await nova.invoke(WORKSPACE_DELETE_SESSION, { sessionId: firstSessionId })
    await nova.invoke(WORKSPACE_DELETE_SESSION, { sessionId: secondSessionId })
    await expect.poll(async () => nova.invoke(CODEINDEX_GET_STATUS)).toMatchObject({
      enabled: false,
      workspaceRoot: null,
      status: 'idle'
    })
    expect(nova.pageErrors).toEqual([])
  } finally {
    await rm(secondWorkspace, { recursive: true, force: true })
    await nova.cleanup()
  }
})
