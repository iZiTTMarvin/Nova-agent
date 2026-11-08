import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
  EVIDENCE_OPEN_BROWSER,
  EVIDENCE_READ_ARTIFACT,
  BROWSER_CLAIM,
  BROWSER_GET_SNAPSHOT,
  BROWSER_NAVIGATE,
  BROWSER_OBSERVE,
  BROWSER_OPEN,
  WORKSPACE_SET_PERMISSION_MODE
} from '../../../src/shared/ipc/channels'
import type { BrowserObserveResult } from '../../../src/shared/browser'

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
}

async function startFormFixture(): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page('Form', `
      <input id="email" aria-label="邮箱">
      <button id="save" type="button">保存</button>
      <p id="out"></p>
      <script>
        document.getElementById('save').onclick = () => {
          document.getElementById('out').textContent = 'saved:' + document.getElementById('email').value;
        };
      </script>
    `))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

function toolTexts(body: unknown): string[] {
  if (!body || typeof body !== 'object' || !('messages' in body) || !Array.isArray(body.messages)) {
    return []
  }
  const texts: string[] = []
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || !('role' in message) || message.role !== 'tool') continue
    if (!('content' in message)) continue
    if (typeof message.content === 'string') texts.push(message.content)
    if (Array.isArray(message.content)) {
      const blocks = message.content as unknown[]
      texts.push(
        blocks
          .map((block) => {
            if (!block || typeof block !== 'object' || !('type' in block) || !('text' in block)) return ''
            const record = block as { type: unknown; text: unknown }
            return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
          })
          .filter((text) => text.length > 0)
          .join('\n')
      )
    }
  }
  return texts
}

function field(text: string, key: string): string {
  const match = new RegExp(`^${key}: (.+)$`, 'm').exec(text)
  return match?.[1]?.trim() ?? ''
}

function namedRef(text: string, name: string): string {
  const match = new RegExp(`^- (\\S+)\\s+\\S+\\s+${name}$`, 'm').exec(text)
  return match?.[1] ?? ''
}

async function grantFullAccess(nova: NovaHarness): Promise<string> {
  const workspace = await nova.getWorkspace()
  const sessionId = workspace.currentSessionId
  if (!sessionId) throw new Error('没有当前会话')
  await nova.invoke(WORKSPACE_SET_PERMISSION_MODE, { sessionId, permissionMode: 'full_access' })
  return sessionId
}

test('模型 observe 后填写并提交表单，页面结果可核对', async ({ nova }) => {
  test.setTimeout(90_000)
  await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    let step = 0
    let emailRef = ''
    let saveRef = ''
    nova.provider.setTurnFactory((record) => {
      const texts = toolTexts(record.body)
      const latest = texts.at(-1) ?? ''
      if (step === 0) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_open',
          arguments: { action: 'open', url: `${fixture.origin}/` },
          callId: 'e2e_browser_open'
        }
      }
      if (step === 1) {
        step += 1
        const browserId = field(latest, 'browserId')
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_browser_observe'
        }
      }
      if (step === 2) {
        step += 1
        emailRef = namedRef(latest, '邮箱')
        saveRef = namedRef(latest, '保存')
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: {
              browserId: field(latest, 'browserId'),
              generation: Number(field(latest, 'generation')),
              documentEpoch: Number(field(latest, 'documentEpoch')),
              observationId: field(latest, 'observationId')
            },
            action: { kind: 'fill', ref: emailRef, text: '你好' }
          },
          callId: 'e2e_browser_fill'
        }
      }
      if (step === 3) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: {
              browserId: field(latest, 'browserId'),
              generation: Number(field(latest, 'generation')),
              documentEpoch: Number(field(latest, 'documentEpoch')),
              observationId: field(latest, 'observationId')
            },
            action: { kind: 'click', ref: saveRef }
          },
          callId: 'e2e_browser_click'
        }
      }
      if (step === 4) {
        step += 1
        const browserId = field(latest, 'browserId')
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_browser_recheck'
        }
      }
      if (step === 5) {
        step += 1
        expect(latest).toContain('saved:你好')
        expect(latest).toMatch(/dpr=\d/)
        expect(latest).toContain('simulated=')
        expect(latest).toContain('displayScale=')
        return {
          kind: 'tool',
          name: 'write',
          arguments: { path: 'preview-recheck.txt', content: 'PREVIEW_RECHECK_OK' },
          callId: 'e2e_browser_write'
        }
      }
      return { kind: 'text', text: 'NOVA_E2E_BROWSER_FORM_OK' }
    })

    await nova.sendPrompt('打开表单，填写邮箱并保存')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_FORM_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(emailRef).toBeTruthy()
    expect(saveRef).toBeTruthy()

    const workspace = await nova.getWorkspace()
    const sessionId = workspace.currentSessionId
    expect(sessionId).toBeTruthy()
    const listed = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId: sessionId! })
    const browserId = listed.status === 'applied' ? listed.snapshot.activeBrowserId : null
    expect(browserId).toBeTruthy()
    const view = await nova.invoke(BROWSER_OBSERVE, {
      sessionId: sessionId!,
      browserId: browserId!
    }) as BrowserObserveResult
    expect(view.status).toBe('applied')
    if (view.status === 'applied') {
      expect(view.snapshot.dom).toContain('saved:你好')
      expect(view.snapshot.viewport.deviceScaleFactor).toBeGreaterThan(0)
      expect(view.snapshot.viewport.simulated).toBe(false)
    }
    expect(readFileSync(path.join(nova.workspacePath, 'preview-recheck.txt'), 'utf8')).toContain('PREVIEW_RECHECK_OK')
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})

test('计划模式拒绝网页写入动作', async ({ nova }) => {
  test.setTimeout(60_000)
  await nova.createSession('plan')
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'browser_act',
      arguments: {
        observation: {
          browserId: 'brw_dummy',
          generation: 1,
          documentEpoch: 1,
          observationId: 'obs_dummy'
        },
        action: { kind: 'click', ref: 'e1' }
      },
      callId: 'e2e_browser_denied'
    },
    { kind: 'text', text: 'NOVA_E2E_BROWSER_DENIED' }
  )
  await nova.sendPrompt('在计划模式点击网页')
  await expect(nova.page.getByText('NOVA_E2E_BROWSER_DENIED', { exact: false })).toBeVisible()
  await nova.waitUntilIdle()
  const second = JSON.stringify(nova.provider.requests[1]?.body ?? {})
  expect(second).toMatch(/plan|权限|不允许|network\.write|browser_act/i)
})

test('观察后接管或导航，旧动作不能落到新页', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as { status: string; page?: { browserId: string } }
    expect(opened.status).toBe('applied')
    const browserId = opened.page!.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_observe',
        arguments: { action: 'snapshot', browserId },
        callId: 'e2e_stale_observe'
      },
      { kind: 'text', text: 'NOVA_E2E_BROWSER_OBSERVED' }
    )
    await nova.sendPrompt('先观察这个表单')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_OBSERVED', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const observed = toolTexts(nova.provider.requests[1]?.body).at(-1) ?? ''
    const oldObservation = {
      browserId: field(observed, 'browserId') || browserId,
      generation: Number(field(observed, 'generation') || '1'),
      documentEpoch: Number(field(observed, 'documentEpoch') || '1'),
      observationId: field(observed, 'observationId')
    }
    const emailRef = namedRef(observed, '邮箱')
    expect(oldObservation.observationId).toBeTruthy()
    expect(emailRef).toBeTruthy()

    await nova.invoke(BROWSER_CLAIM, { sessionId, browserId })
    await nova.invoke(BROWSER_NAVIGATE, {
      sessionId,
      browserId,
      action: { kind: 'url', url: `${fixture.origin}/?next=1` }
    })

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_act',
        arguments: {
          observation: oldObservation,
          action: { kind: 'fill', ref: emailRef, text: '不该写入' }
        },
        callId: 'e2e_stale_act'
      },
      { kind: 'text', text: 'NOVA_E2E_BROWSER_STALE_OK' }
    )
    await nova.sendPrompt('用刚才的观察去填写')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_STALE_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const denied = toolTexts(nova.provider.requests.at(-1)?.body).join('\n')
    expect(denied).toMatch(/stale_observation|taken_over/)
    const view = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
    expect(view.status).toBe('applied')
    if (view.status === 'applied') {
      expect(view.snapshot.dom).not.toContain('saved:不该写入')
      expect(view.snapshot.dom).not.toContain('不该写入')
    }
  } finally {
    await fixture.close()
  }
})

test('命名目标聚焦观察只交付目标语义', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url: `${fixture.origin}/` }) as {
      status: string
      page?: { browserId: string }
    }
    expect(opened.status).toBe('applied')
    const browserId = opened.page!.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()
    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_observe',
        arguments: { action: 'snapshot', browserId, focus: { role: 'button', name: '保存' } },
        callId: 'e2e_focused_observe'
      },
      { kind: 'text', text: 'NOVA_E2E_FOCUS_OK' }
    )
    await nova.sendPrompt('只观察保存按钮')
    await expect(nova.page.getByText('NOVA_E2E_FOCUS_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const observed = toolTexts(nova.provider.requests[1]?.body).at(-1) ?? ''
    expect(observed).toContain('scope: focused')
    expect(observed).toContain('保存')
    expect(observed).not.toContain('邮箱')

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_observe',
        arguments: { action: 'snapshot', browserId, focus: { role: 'button', name: '不存在' } },
        callId: 'e2e_focus_fallback'
      },
      { kind: 'text', text: 'NOVA_E2E_FALLBACK_OK' }
    )
    await nova.sendPrompt('观察不存在的按钮并回退')
    await expect(nova.page.getByText('NOVA_E2E_FALLBACK_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const fallback = toolTexts(nova.provider.requests.at(-1)?.body).at(-1) ?? ''
    expect(fallback).toContain('scope: full_fallback (missing)')
    expect(fallback).toContain('邮箱')
    expect(field(fallback, 'observationId')).not.toBe(field(observed, 'observationId'))
  } finally {
    await fixture.close()
  }
})

test('观察与点击之间点接管，旧命令不能落到页面', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as { status: string; page?: { browserId: string } }
    expect(opened.status).toBe('applied')
    const browserId = opened.page!.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()

    let step = 0
    nova.provider.setTurnFactory(async (record) => {
      const texts = toolTexts(record.body)
      const latest = texts.at(-1) ?? ''
      if (step === 0) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_takeover_observe'
        }
      }
      if (step === 1) {
        step += 1
        const oldObservation = {
          browserId: field(latest, 'browserId') || browserId,
          generation: Number(field(latest, 'generation') || '1'),
          documentEpoch: Number(field(latest, 'documentEpoch') || '1'),
          observationId: field(latest, 'observationId')
        }
        const saveRef = namedRef(latest, '保存')
        await nova.page.getByRole('button', { name: '接管页面' }).click()
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: oldObservation,
            action: { kind: 'click', ref: saveRef }
          },
          callId: 'e2e_takeover_click'
        }
      }
      return { kind: 'text', text: 'NOVA_E2E_BROWSER_TAKEOVER_OK' }
    })

    await nova.sendPrompt('观察后点击保存')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_TAKEOVER_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const denied = toolTexts(nova.provider.requests.at(-1)?.body).join('\n')
    expect(denied).toMatch(/stale_observation|taken_over/)
    const view = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
    expect(view.status).toBe('applied')
    if (view.status === 'applied') {
      expect(view.snapshot.dom).not.toContain('saved:')
    }
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})

test('接管后重新观察也不能夺回；交还后重新观察可继续操作', async ({ nova }) => {
  test.setTimeout(120_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as { status: string; page?: { browserId: string } }
    expect(opened.status).toBe('applied')
    const browserId = opened.page!.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()

    const readObservation = (latest: string) => ({
      browserId: field(latest, 'browserId') || browserId,
      generation: Number(field(latest, 'generation') || '1'),
      documentEpoch: Number(field(latest, 'documentEpoch') || '1'),
      observationId: field(latest, 'observationId')
    })
    let step = 0
    const toolResults: string[] = []
    nova.provider.setTurnFactory(async (record) => {
      const latest = toolTexts(record.body).at(-1) ?? ''
      if (step > 0) toolResults.push(latest)
      if (step === 0) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_lease_observe_1'
        }
      }
      if (step === 1) {
        step += 1
        await nova.page.getByRole('button', { name: '接管页面' }).click()
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: readObservation(latest),
            action: { kind: 'click', ref: namedRef(latest, '保存') }
          },
          callId: 'e2e_lease_stale_click'
        }
      }
      if (step === 2) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_lease_observe_2'
        }
      }
      if (step === 3) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: readObservation(latest),
            action: { kind: 'click', ref: namedRef(latest, '保存') }
          },
          callId: 'e2e_lease_denied_click'
        }
      }
      if (step === 4) {
        step += 1
        await nova.page.getByRole('button', { name: '交还 AI 控制' }).click()
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_lease_observe_3'
        }
      }
      if (step === 5) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: readObservation(latest),
            action: { kind: 'click', ref: namedRef(latest, '保存') }
          },
          callId: 'e2e_lease_final_click'
        }
      }
      return { kind: 'text', text: 'NOVA_E2E_BROWSER_LEASE_OK' }
    })

    await nova.sendPrompt('点击保存按钮')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_LEASE_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const all = toolResults.join('\n\n')
    // 接管后：旧观察被拒；重新观察本身可用，但其后的操作仍被拒
    expect(all).toMatch(/taken_over/)
    expect(all).toContain('observationId:')
    const finalView = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
    expect(finalView.status).toBe('applied')
    if (finalView.status === 'applied') {
      expect(finalView.snapshot.dom).toContain('saved:')
    }
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})

test('手机视口模拟可复核，接管后旧的恢复不会改回尺寸', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, {
      sessionId,
      url: `${fixture.origin}/`
    }) as { status: string; page?: { browserId: string } }
    expect(opened.status).toBe('applied')
    const browserId = opened.page!.browserId
    await nova.page.locator('webview[data-browser-id]').waitFor()

    let step = 0
    let savedObservation: {
      browserId: string
      generation: number
      documentEpoch: number
      observationId: string
    } | null = null
    nova.provider.setTurnFactory(async (record) => {
      const latest = toolTexts(record.body).at(-1) ?? ''
      if (step === 0) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_viewport_observe'
        }
      }
      if (step === 1) {
        step += 1
        savedObservation = {
          browserId: field(latest, 'browserId') || browserId,
          generation: Number(field(latest, 'generation') || '1'),
          documentEpoch: Number(field(latest, 'documentEpoch') || '1'),
          observationId: field(latest, 'observationId')
        }
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: savedObservation,
            action: { kind: 'viewport', width: 390, height: 844, device: 'mobile' }
          },
          callId: 'e2e_viewport_set'
        }
      }
      if (step === 2) {
        step += 1
        expect(latest).toContain('status: applied')
        expect(latest).toContain('390')
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot', browserId },
          callId: 'e2e_viewport_evidence'
        }
      }
      if (step === 3) {
        step += 1
        expect(latest).toContain('simulated=yes')
        expect(latest).toMatch(/dpr=/)
        expect(latest).toContain('displayScale=')
        await nova.page.getByRole('button', { name: '接管页面' }).click()
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: savedObservation,
            action: { kind: 'viewport', width: 1280, height: 800, device: 'desktop' }
          },
          callId: 'e2e_viewport_restore'
        }
      }
      return { kind: 'text', text: 'NOVA_E2E_BROWSER_VIEWPORT_OK' }
    })

    await nova.sendPrompt('用手机视口看这个页面')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_VIEWPORT_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const denied = toolTexts(nova.provider.requests.at(-1)?.body).join('\n')
    expect(denied).toMatch(/taken_over/)
    const view = await nova.invoke(BROWSER_OBSERVE, { sessionId, browserId }) as BrowserObserveResult
    expect(view.status).toBe('applied')
    if (view.status === 'applied') {
      expect(view.snapshot.viewport.width).toBe(390)
      expect(view.snapshot.viewport.height).toBe(844)
      expect(view.snapshot.viewport.simulated).toBe(true)
      expect(view.snapshot.viewport.device).toBe('mobile')
    }
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})

test('模型常见写法走通整条链路：多填字段、原页跳转、省略 browserId、复制 observation 行', async ({ nova }) => {
  test.setTimeout(90_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    let step = 0
    let browserId = ''
    let backResult = ''
    const failures: string[] = []
    nova.provider.setTurnFactory((record) => {
      const latest = toolTexts(record.body).at(-1) ?? ''
      if (step > 0 && /\[(invalid_request|not_owner|stale_observation|navigation_failed|outcome_unknown|timeout)\]/.test(latest)) failures.push(latest)
      if (step === 0) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_open',
          arguments: { action: 'open', url: `${fixture.origin}/`, browserId: null },
          callId: 'e2e_model_open'
        }
      }
      if (step === 1) {
        step += 1
        browserId = field(latest, 'browserId')
        // 代理打开要等首屏提交后回报，标题应已是页面真实标题
        expect(field(latest, 'title')).toBe('Form')
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'list', browserId },
          callId: 'e2e_model_list'
        }
      }
      if (step === 2) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_open',
          arguments: { action: 'open', browserId, url: `${fixture.origin}/next` },
          callId: 'e2e_model_navigate'
        }
      }
      if (step === 3) {
        step += 1
        return {
          kind: 'tool',
          name: 'browser_observe',
          arguments: { action: 'snapshot' },
          callId: 'e2e_model_snapshot'
        }
      }
      if (step === 4) {
        step += 1
        expect(field(latest, 'url')).toBe(`${fixture.origin}/next`)
        return {
          kind: 'tool',
          name: 'browser_act',
          arguments: {
            observation: JSON.parse(field(latest, 'observation')) as unknown,
            action: { kind: 'click', ref: namedRef(latest, '保存'), text: null, values: null }
          },
          callId: 'e2e_model_click'
        }
      }
      if (step === 5) {
        step += 1
        expect(latest).toContain('status: applied')
        return {
          kind: 'tool',
          name: 'browser_open',
          arguments: { action: 'back', browserId, url: '' },
          callId: 'e2e_model_back'
        }
      }
      if (step === 6) {
        step += 1
        backResult = latest
        return {
          kind: 'tool',
          name: 'browser_open',
          arguments: { action: 'reload', browserId },
          callId: 'e2e_model_reload'
        }
      }
      expect(latest).toContain('lifecycle: ready')
      expect(field(latest, 'url')).toBe(`${fixture.origin}/`)
      return { kind: 'text', text: 'NOVA_E2E_BROWSER_MODEL_ARGS_OK' }
    })

    await nova.sendPrompt('打开页面，跳到下一页点保存，再后退')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_MODEL_ARGS_OK', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    expect(failures).toEqual([])
    // 后退的回报必须已是后退后的地址，否则模型会以为没生效而重复后退
    expect(field(backResult, 'url')).toBe(`${fixture.origin}/`)
    const listed = await nova.invoke(BROWSER_GET_SNAPSHOT, { sessionId })
    expect(listed.status).toBe('applied')
    if (listed.status === 'applied') {
      expect(listed.snapshot.pages.map((item) => item.browserId)).toEqual([browserId])
      expect(listed.snapshot.pages[0]?.url).toBe(`${fixture.origin}/`)
    }
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})

test('真实截图和命令产物经过选择、IPC 读取与刷新恢复，失效页面和跨会话请求被拒绝', async ({ nova }) => {
  test.setTimeout(120_000)
  const sessionId = await grantFullAccess(nova)
  const fixture = await startFormFixture()
  try {
    const opened = await nova.invoke(BROWSER_OPEN, { sessionId, url: `${fixture.origin}/` })
    if (opened.status !== 'applied') throw new Error('Fixture browser did not open')
    const browserId = opened.page.browserId
    await expect(nova.page.locator('webview[data-browser-id]')).toBeVisible()
    let step = 0
    let imageUrl = ''
    let artifactId = ''
    nova.provider.setTurnFactory(record => {
      const latest = toolTexts(record.body).at(-1) ?? ''
      switch (step++) {
        case 0: return { kind: 'tool', name: 'browser_observe', arguments: { action: 'snapshot', browserId }, callId: 'evidence-observe' }
        case 1: return { kind: 'tool', name: 'browser_capture', arguments: { observation: {
          browserId, generation: Number(field(latest, 'generation')), documentEpoch: Number(field(latest, 'documentEpoch')),
          observationId: field(latest, 'observationId')
        } }, callId: 'evidence-capture' }
        case 2:
          imageUrl = field(latest, 'imageEvidence')
          expect(imageUrl).toMatch(/^nova-image:\/\//)
          return { kind: 'tool', name: 'present_evidence', arguments: { items: [{ kind: 'image', url: imageUrl, description: '真实表单截图，未声明视觉验收通过' }] }, callId: 'evidence-image-delivery' }
        case 3:
          expect(latest).toContain('已选择真实产物')
          return { kind: 'tool', name: 'bash', arguments: { command: `node -e "process.stdout.write('EVIDENCE_OUTPUT'.repeat(6000))"` }, callId: 'evidence-command' }
        case 4:
          artifactId = /artifact:\/\/([a-z0-9-]+)/.exec(latest)?.[1] ?? ''
          expect(artifactId).not.toBe('')
          return { kind: 'tool', name: 'present_evidence', arguments: { items: [{ kind: 'artifact', artifactId, description: '真实命令输出' }] }, callId: 'evidence-log-delivery' }
        default:
          expect(latest).toContain('已选择真实产物')
          return { kind: 'text', text: 'NOVA_EVIDENCE_STORAGE_OK' }
      }
    })
    await nova.sendPrompt('保留真实截图与命令输出供查看')
    await expect(nova.page.getByText('NOVA_EVIDENCE_STORAGE_OK', { exact: true })).toBeVisible()
    await nova.waitUntilIdle()
    const before = await nova.invoke('load-session', { sessionId })
    const evidenceBlocks = before?.messages.flatMap(message => message.blocks ?? []).filter(block => block.type === 'tool' && block.toolName === 'present_evidence')
    expect(evidenceBlocks).toHaveLength(2)
    expect(JSON.stringify(evidenceBlocks)).not.toMatch(/resultImages|base64/)
    expect(await nova.invoke(EVIDENCE_READ_ARTIFACT, { sessionId, id: artifactId })).toEqual({ status: 'available', text: 'EVIDENCE_OUTPUT'.repeat(6000) })
    expect(await nova.invoke(EVIDENCE_OPEN_BROWSER, { sessionId, id: imageUrl })).toMatchObject({ status: 'applied', page: { browserId } })
    const loadImage = () => nova.page.evaluate(url => new Promise<boolean>(resolve => {
      const image = new Image()
      image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0)
      image.onerror = () => resolve(false)
      image.src = url
    }), imageUrl)
    expect(await loadImage()).toBe(true)
    await nova.page.reload()
    await expect(nova.page.getByText('NOVA_EVIDENCE_STORAGE_OK', { exact: true })).toBeVisible()
    const after = await nova.invoke('load-session', { sessionId })
    expect(after?.messages.flatMap(message => message.blocks ?? []).filter(block => block.type === 'tool' && block.toolName === 'present_evidence')).toEqual(evidenceBlocks)
    expect(await loadImage()).toBe(true)
    expect(await nova.invoke(EVIDENCE_READ_ARTIFACT, { sessionId, id: artifactId })).toMatchObject({ status: 'available' })
    expect(await nova.invoke(EVIDENCE_OPEN_BROWSER, { sessionId, id: imageUrl })).toMatchObject({ status: 'not_applied' })
    const other = await nova.createSession('pilot')
    expect(await nova.invoke(EVIDENCE_READ_ARTIFACT, { sessionId: other.currentSessionId!, id: artifactId })).toMatchObject({ status: 'unavailable' })
    expect(await nova.invoke(EVIDENCE_OPEN_BROWSER, { sessionId: other.currentSessionId!, id: imageUrl })).toMatchObject({ status: 'not_applied' })
    const imageFile = path.join(nova.profileRoot, 'userData', 'sessions', sessionId, 'images', new URL(imageUrl).pathname.slice(1))
    expect(existsSync(imageFile)).toBe(true)
    await nova.invoke('workspace:delete-session', { sessionId })
    expect(existsSync(imageFile)).toBe(false)
    expect(await loadImage()).toBe(false)
    expect(await nova.invoke(EVIDENCE_READ_ARTIFACT, { sessionId, id: artifactId })).toMatchObject({ status: 'unavailable' })
    expect(nova.pageErrors).toEqual([])
  } finally {
    nova.provider.setTurnFactory(null)
    await fixture.close()
  }
})
