/**
 * 开发服务器生命周期：bash 让出启动真实 HTTP 服务 → 测试侧直连端口确认在跑 →
 * shell_session 续读日志 → stop 结束进程 → 端口不再可连 → 重启一次再停止。
 * 全程只等可观察条件（端口可连/不可连、快照终态），不靠 sleep 推进。
 */
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type NovaHarness } from '../fixtures/nova'
import { SETTINGS_SET } from '../../../src/shared/ipc/channels'
import type { RecordedRequest } from '../fixtures/fake-runtime'

process.env['NOVA_BASH_YIELD_BOUNDARY_MS'] = '4000'

const SERVER_JS = `
const http = require('http')
const port = Number(process.argv[2])
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('NOVA_E2E_SERVER_OK')
})
server.listen(port, '127.0.0.1', () => console.log('SERVER_READY ' + port))
`

/** 从真实模型请求体里找 bash 让出时回灌的进程会话引用（取最后一个） */
function findLastSessionRef(requests: RecordedRequest[]): string | null {
  let found: string | null = null
  for (const request of requests) {
    const messages = request.body['messages']
    if (!Array.isArray(messages)) continue
    for (const message of messages) {
      const content = (message as { content?: unknown }).content
      if (typeof content !== 'string') continue
      const match = /psn_[A-Za-z0-9_-]+/.exec(content)
      if (match) found = match[0]
    }
  }
  return found
}

async function pickFreePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise<void>(resolve => probe.close(() => resolve()))
  return port
}

async function probeServer(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return (await res.text()) === 'NOVA_E2E_SERVER_OK'
  } catch {
    return false
  }
}

async function waitServerUp(port: number): Promise<void> {
  await expect.poll(() => probeServer(port), { timeout: 15_000 }).toBe(true)
}

async function waitServerDown(port: number): Promise<void> {
  await expect.poll(() => probeServer(port), { timeout: 15_000 }).toBe(false)
}

async function bashStartServer(nova: NovaHarness, port: number, doneText: string): Promise<void> {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'bash',
      arguments: { command: `node server.js ${port}`, description: '启动开发服务器' },
      callId: `call_bash_${port}_${doneText}`
    },
    { kind: 'text', text: doneText }
  )
  await nova.sendPrompt(`启动 server.js 监听 ${port} 端口`)
  await expect(nova.page.getByText(doneText)).toBeVisible()
  await nova.waitUntilIdle()
}

async function shellAction(nova: NovaHarness, ref: string, action: 'read' | 'stop', doneText: string): Promise<void> {
  nova.provider.enqueue(
    {
      kind: 'tool',
      name: 'shell_session',
      arguments: { ref, action },
      callId: `call_shell_${action}_${doneText}`
    },
    { kind: 'text', text: doneText }
  )
  await nova.sendPrompt(action === 'read' ? '看看服务器输出' : '把服务器停掉')
  await expect(nova.page.getByText(doneText)).toBeVisible()
  await nova.waitUntilIdle()
}

test('Agent 启动的 HTTP 服务可访问、可读日志、可停止且可重启', async ({ nova }) => {
  test.setTimeout(150_000)
  await nova.invoke(SETTINGS_SET, { defaultPermissionMode: 'auto' })
  await writeFile(join(nova.workspacePath, 'server.js'), SERVER_JS, 'utf8')
  const port = await pickFreePort()

  // 第一次启动：让出后测试侧直连端口确认服务真实在监听
  await bashStartServer(nova, port, 'SERVER_STARTED_1')
  await waitServerUp(port)

  // 续读输出：下一轮模型请求体里应带上 SERVER_READY 日志（证明 read 真读到了）
  const ref1 = findLastSessionRef(nova.provider.requests)
  expect(ref1).not.toBeNull()
  const requestCountBeforeRead = nova.provider.requests.length
  await shellAction(nova, ref1 ?? '', 'read', 'READ_DONE')
  const bodyAfterRead = nova.provider.requests
    .slice(requestCountBeforeRead)
    .map(r => JSON.stringify(r.body))
    .join('\n')
  expect(bodyAfterRead).toContain('SERVER_READY')
  await waitServerUp(port)

  // 停止：端口不再可连
  await shellAction(nova, ref1 ?? '', 'stop', 'STOPPED_1')
  await waitServerDown(port)

  // 重启：同一命令再次让出、可访问，然后停掉第二个进程
  await bashStartServer(nova, port, 'SERVER_STARTED_2')
  await waitServerUp(port)
  const ref2 = findLastSessionRef(nova.provider.requests)
  expect(ref2).not.toBeNull()
  expect(ref2).not.toBe(ref1)
  await shellAction(nova, ref2 ?? '', 'stop', 'STOPPED_2')
  await waitServerDown(port)

  expect(nova.pageErrors).toEqual([])
})
