import { rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test } from '../fixtures/nova'
import { BROWSER_OPEN, WORKSPACE_SET_PERMISSION_MODE } from '../../../src/shared/ipc/channels'

function toolText(body: unknown): string {
  const messages = body && typeof body === 'object' && 'messages' in body && Array.isArray(body.messages) ? body.messages : []
  const last = [...messages].reverse().find(message => message?.role === 'tool')
  return typeof last?.content === 'string' ? last.content : ''
}

function field(text: string, key: string): string {
  return new RegExp(`^${key}: (.+)$`, 'm').exec(text)?.[1]?.trim() ?? ''
}

test('证据卡展示真实截图与日志，刷新恢复，切会话不串，失效页面与缺失图片如实提示', async ({ nova }, testInfo) => {
  test.setTimeout(120_000)
  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId!
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><title>Evidence</title><body><h1>证据页面</h1></body>')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` })
    if (opened.status !== 'applied') throw new Error('Fixture browser did not open')
    const browserId = opened.page.browserId
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()

    let step = 0
    let imageUrl = ''
    nova.provider.setTurnFactory(record => {
      const latest = toolText(record.body)
      switch (step++) {
        case 0: return { kind: 'tool', name: 'browser_observe', arguments: { action: 'snapshot', browserId }, callId: 'ui-observe' }
        case 1: return { kind: 'tool', name: 'browser_capture', arguments: { observation: {
          browserId, generation: Number(field(latest, 'generation')), documentEpoch: Number(field(latest, 'documentEpoch')),
          observationId: field(latest, 'observationId')
        } }, callId: 'ui-capture' }
        case 2:
          imageUrl = field(latest, 'imageEvidence')
          return { kind: 'tool', name: 'bash', arguments: { command: `node -e "process.stdout.write('UI_EVIDENCE_LOG'.repeat(6000))"` }, callId: 'ui-command' }
        case 3: {
          const artifactId = /artifact:\/\/([a-z0-9-]+)/.exec(latest)?.[1] ?? ''
          return { kind: 'tool', name: 'present_evidence', arguments: { items: [
            { kind: 'image', url: imageUrl, description: '表单页面截图，仅记录当时画面' },
            { kind: 'artifact', artifactId, description: '命令输出' }
          ] }, callId: 'ui-present' }
        }
        default: return { kind: 'text', text: 'NOVA_EVIDENCE_UI_OK' }
      }
    })
    await nova.sendPrompt('保留截图与命令输出')
    await expect(nova.page.getByText('NOVA_EVIDENCE_UI_OK', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()

    const card = nova.page.getByTestId('evidence-card')
    await expect(card).toContainText('仅表示产物存在，不代表目标已验证')
    await expect(card).not.toContainText(/通过|成功/)
    const image = card.locator('img')
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    await testInfo.attach('evidence-card', { body: await card.screenshot(), contentType: 'image/png' })

    await card.getByRole('button', { name: '查看日志' }).click()
    await expect(card.locator('pre')).toContainText('UI_EVIDENCE_LOG')
    await card.getByRole('button', { name: '打开实时结果' }).click()
    await expect(card).toContainText('已打开实时页面')

    await nova.page.reload()
    await expect(nova.page.getByTestId('evidence-card')).toBeVisible()
    await nova.page.reload()
    const restored = nova.page.getByTestId('evidence-card')
    await expect(restored).toBeVisible()
    await restored.getByRole('button', { name: '查看日志' }).click()
    await expect(restored.locator('pre')).toContainText('UI_EVIDENCE_LOG')
    await restored.getByRole('button', { name: '打开实时结果' }).click()
    await expect(restored).toContainText('实时页面不可用')

    nova.provider.setTurnFactory(null)
    const other = await nova.createFreshSession('pilot')
    await expect(nova.page.getByTestId('evidence-card')).toHaveCount(0)
    await nova.selectSession(sessionId)
    await expect(nova.page.getByTestId('evidence-card')).toBeVisible()

    rmSync(path.join(nova.profileRoot, 'userData', 'sessions', sessionId, 'images', new URL(imageUrl).pathname.slice(1)))
    await nova.page.reload()
    await expect(nova.page.getByTestId('evidence-card')).toContainText('截图不可用')
    expect(nova.pageErrors).toEqual([])
  } finally {
    nova.provider.setTurnFactory(null)
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
