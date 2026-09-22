import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import {
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
    }
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

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_observe',
        arguments: { action: 'snapshot', browserId },
        callId: 'e2e_takeover_observe'
      },
      { kind: 'text', text: 'NOVA_E2E_BROWSER_TAKEOVER_OBSERVED' }
    )
    await nova.sendPrompt('先观察这个表单')
    await expect(nova.page.getByText('NOVA_E2E_BROWSER_TAKEOVER_OBSERVED', { exact: false })).toBeVisible()
    await nova.waitUntilIdle()
    const observed = toolTexts(nova.provider.requests[1]?.body).at(-1) ?? ''
    const oldObservation = {
      browserId: field(observed, 'browserId') || browserId,
      generation: Number(field(observed, 'generation') || '1'),
      documentEpoch: Number(field(observed, 'documentEpoch') || '1'),
      observationId: field(observed, 'observationId')
    }
    const saveRef = namedRef(observed, '保存')
    expect(oldObservation.observationId).toBeTruthy()
    expect(saveRef).toBeTruthy()

    await nova.page.getByRole('button', { name: '接管页面' }).click()

    nova.provider.enqueue(
      {
        kind: 'tool',
        name: 'browser_act',
        arguments: {
          observation: oldObservation,
          action: { kind: 'click', ref: saveRef }
        },
        callId: 'e2e_takeover_click'
      },
      { kind: 'text', text: 'NOVA_E2E_BROWSER_TAKEOVER_OK' }
    )
    await nova.sendPrompt('用刚才的观察去点击保存')
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
    await fixture.close()
  }
})
