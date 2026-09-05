import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatEvent } from '../../../src/runtime/model/types'

function semantic(res: ServerResponse, text: string, finish = false): void {
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finish ? 'stop' : null }] })}\n\n`)
  if (finish) res.end('data: [DONE]\n\n')
}

describe('真实 HTTP 传输边界', () => {
  it('分开测量默认与试验窗口：慢头、慢语义、comment 黑洞及 80 秒语义间隔', async () => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const records: Array<{ scenario: string; started: number; headers?: number; closed?: number }> = []
    const schedule = (ms: number, action: () => void): void => {
      const timer = setTimeout(() => { timers.delete(timer); action() }, ms)
      timers.add(timer)
    }
    const server = createServer(async (req, res) => {
      for await (const _chunk of req) { /* consume request */ }
      const scenario = req.url!.split('/')[1]
      const record = { scenario, started: Date.now(), headers: undefined as number | undefined, closed: undefined as number | undefined }
      records.push(record)
      res.on('close', () => { record.closed = Date.now() })
      const headers = (): void => { record.headers = Date.now(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders() }
      if (scenario.startsWith('headers')) {
        schedule(scenario.includes('35') ? 35_000 : 59_000, () => { if (!res.destroyed) { headers(); semantic(res, 'ok', true) } })
      } else {
        headers()
        if (scenario.startsWith('semantic')) {
          res.write(': comment\n\n')
          schedule(scenario.includes('65') ? 65_000 : 85_000, () => { if (!res.destroyed) semantic(res, 'ok', true) })
        } else if (scenario === 'progress') {
          semantic(res, 'start')
          schedule(80_000, () => { if (!res.destroyed) semantic(res, 'middle') })
          schedule(160_000, () => { if (!res.destroyed) semantic(res, 'end', true) })
        } else {
          if (scenario === 'idle-comment') semantic(res, 'start')
          for (let ms = 10_000; ms <= 120_000; ms += 10_000) schedule(ms, () => { if (!res.destroyed) res.write(': comment\n\n') })
        }
      }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing HTTP port')
    const run = async (scenario: string, experimental: boolean): Promise<{ scenario: string; experimental: boolean; elapsed: number; terminal: string }> => {
      const client = new OpenAICompatibleModelClient({ baseUrl: `http://127.0.0.1:${address.port}/${scenario}`, apiKey: 'fixture', modelId: 'fixture' })
      const events: ChatEvent[] = []
      const start = Date.now()
      for await (const event of client.chat([{ role: 'user', content: 'timing fixture' }], undefined,
        experimental ? { transportTimeouts: { connectMs: 75_000, firstByteMs: 120_000 } } : undefined)) events.push(event)
      const failure = events.find(event => event.type === 'error')
      return { scenario, experimental, elapsed: Date.now() - start, terminal: failure?.type === 'error' ? failure.error : events.at(-1)?.type ?? 'missing' }
    }
    try {
      const results = await Promise.all([
        run('headers35', false), run('headers35', true), run('headers59', true),
        run('semantic65', false), run('semantic65', true), run('semantic85', true),
        run('comment', true), run('idle-comment', true), run('progress', true)
      ])
      console.log(JSON.stringify({ kind: 'transport-window-evidence', results, records }))
      expect(results[0].terminal).toContain('timeout_connect')
      expect(results[3].terminal).toContain('timeout_first_byte')
      expect(results[6].terminal).toContain('timeout_first_byte')
      expect(results[7].terminal).toContain('timeout_idle')
      for (const index of [1, 2, 4, 5, 8]) expect(results[index].terminal).toBe('message_end')
      expect(records).toHaveLength(9)
      expect(results[8].elapsed).toBeGreaterThanOrEqual(160_000)
    } finally {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 180_000)
})
