import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVE_MODEL_CONFIG } from '../../../src/shared/ipc/channels'
import { expect, launchNova, test } from '../fixtures/nova'

test('XForge 的图片与失败恢复指令在重启后保持请求前缀，上下文在发送前可见', async ({}, testInfo) => {
  let nova = await launchNova(testInfo)
  try {
    await nova.invoke(SAVE_MODEL_CONFIG, {
      baseUrl: nova.provider.baseUrl, apiKey: 'nova-e2e-key', modelId: 'MiniMax-M3',
      contextWindow: 200_000, supportsVision: true, cacheProfile: 'minimax', toolDialect: 'native'
    })
    await nova.createSession('compose')
    await writeFile(path.join(nova.workspacePath, 'context.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWuoAAAAASUVORK5CYII=', 'base64'))
    nova.provider.enqueue({ kind: 'tool', name: 'read', arguments: { path: 'context.png' }, callId: 'image' })
    for (let i = 0; i < 4; i++) {
      nova.provider.enqueue({ kind: 'tool', name: 'read', arguments: { path: 'missing.txt' }, callId: `missing-${i}` })
    }
    await nova.sendPrompt('读取图片和项目文件，继续分析')
    await expect(nova.page.getByText('[已自动中断]', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(5)
    const before = nova.provider.requests.at(-1)!.body
    expect(JSON.stringify(before.messages)).toContain('data:image/png;base64,')
    expect(JSON.stringify(before.messages)).toContain('[Runtime guard]')
    await nova.app.close()
    nova = await launchNova(testInfo, { skipWorkspaceSetup: true }, nova)
    await nova.page.locator('.context-indicator').hover()
    await expect(nova.page.locator('.context-popover__total')).not.toContainText('等待 LLM 调用')
    await expect(nova.page.locator('.context-popover__list')).toBeVisible()
    await nova.page.getByLabel('消息输入').hover()
    nova.provider.enqueue({ kind: 'text', text: 'NOVA_CONTEXT_RESTART_OK' })
    await nova.sendPrompt('继续分析')
    await expect(nova.page.getByText('NOVA_CONTEXT_RESTART_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(nova.provider.requests).toHaveLength(6)
    const after = nova.provider.requests.at(-1)!.body
    if (!Array.isArray(before.messages) || !Array.isArray(after.messages)) throw new Error('Missing wire messages')
    expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages)
    expect({ ...after, messages: null }).toEqual({ ...before, messages: null })
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
