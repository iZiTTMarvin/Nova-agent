import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { transportFetch } from '../../../../src/runtime/model/ModelTransport'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import type { AgentEvent } from '../../../../src/runtime/agent/types'

async function withServer(handler: (res: ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain request */ }
    handler(res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing HTTP port')
  try { await run(`http://127.0.0.1:${address.port}`) }
  finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('真实 HTTP 取消与未知结果', () => {
  it('上游工作忽略断开时，本地取消仍结算且不声称远端停止', async () => {
    let finishRemote!: () => void
    const remoteWork = new Promise<void>(resolve => { finishRemote = resolve })
    let remoteCompleted = false
    await withServer(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders()
      void remoteWork.then(() => { remoteCompleted = true; if (!res.destroyed) res.end() })
    }, async url => {
      const controller = new AbortController()
      const { response, attempt } = await transportFetch({ url, userSignal: controller.signal })
      const { TransportBodyReader } = await import('../../../../src/runtime/model/ModelTransport')
      const reader = new TransportBodyReader(response.body!, { attempt })
      const pending = reader.read()
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      reader.release()
      expect(attempt.getTiming().settledAt).not.toBeNull()
      expect(attempt.getOutcome()).toBe('cancelled')
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
      expect(remoteCompleted).toBe(false)
      finishRemote()
      await remoteWork
      expect(remoteCompleted).toBe(true)
    })
  })

  it.each(['partial-tool', 'backoff'] as const)('%s 不产生第二次派发或工具副作用', async scenario => {
    let requests = 0
    await withServer(res => {
      requests++
      if (scenario === 'backoff') {
        res.writeHead(429, { 'retry-after': '30' })
        res.end('rate limit')
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', type: 'function', function: { name: 'write', arguments: '{"path":' } }] }, finish_reason: null }] })}\n\n`)
      }
    }, async url => {
      const events: AgentEvent[] = []
      const bus = new EventBus()
      const client = new OpenAICompatibleModelClient({ baseUrl: url, apiKey: 'fixture', modelId: 'fixture' })
      const loop = new AgentLoop(client, bus, { permissionManager: new PermissionManager() })
      bus.on(event => {
        events.push(event)
        if (scenario === 'backoff' && event.type === 'attempt_failed') setTimeout(() => loop.cancel(), 10)
      })
      try {
        await loop.sendMessage('验证取消', agentRoute())
        expect(requests).toBe(1)
        expect(events.filter(event => event.type === 'tool_call')).toHaveLength(0)
        expect(loop.getState()).toBe(scenario === 'backoff' ? 'cancelled' : 'error')
        if (scenario === 'partial-tool') {
          expect(events.filter(event => event.type === 'attempt_failed')).toHaveLength(0)
          expect(events.some(event => event.type === 'error' && event.error.includes('远端结果'))).toBe(true)
        }
      } finally { loop.dispose() }
    })
  }, 5_000)
})
