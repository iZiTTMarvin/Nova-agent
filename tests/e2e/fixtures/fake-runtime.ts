import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

type JsonObject = Record<string, unknown>

export type FakeTurn =
  | {
      kind: 'text'
      text: string
      chunks?: string[]
      chunkDelayMs?: number
    }
  | {
      kind: 'tool'
      name: string
      arguments: JsonObject
      callId?: string
    }
  | {
      kind: 'hold'
      id: string
      text: string
    }
  | {
      kind: 'error'
      status: number
      body?: JsonObject
    }
  | {
      kind: 'raw'
      events: Array<{ payload: JsonObject | '[DONE]'; delayMs?: number }>
    }

export interface RecordedRequest {
  path: string
  body: JsonObject
  aborted: boolean
}

interface Deferred {
  promise: Promise<void>
  resolve: () => void
}

function createDeferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>(done => {
    resolve = done
  })
  return { promise, resolve }
}

function writeSse(res: ServerResponse, payload: JsonObject | '[DONE]'): void {
  const data = payload === '[DONE]' ? '[DONE]' : JSON.stringify(payload)
  res.write(`data: ${data}\n\n`)
}

function contentChunk(content: string): JsonObject {
  return {
    choices: [
      {
        index: 0,
        delta: { content },
        finish_reason: null
      }
    ]
  }
}

function finishChunk(reason: 'stop' | 'tool_calls' = 'stop'): JsonObject {
  return {
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: reason
      }
    ]
  }
}

async function readJson(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be an object')
  }
  return parsed as JsonObject
}

export class FakeRuntime {
  readonly requests: RecordedRequest[] = []

  private readonly turns: FakeTurn[] = []
  private readonly holds = new Map<string, Deferred>()
  private readonly sockets = new Set<Socket>()
  private readonly server = createServer((req, res) => {
    void this.handle(req, res)
  })

  private constructor() {
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
  }

  static async start(): Promise<FakeRuntime> {
    const runtime = new FakeRuntime()
    await new Promise<void>((resolve, reject) => {
      runtime.server.once('error', reject)
      runtime.server.listen(0, '127.0.0.1', () => {
        runtime.server.off('error', reject)
        resolve()
      })
    })
    return runtime
  }

  get baseUrl(): string {
    const address = this.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('fake runtime is not listening')
    }
    return `http://127.0.0.1:${address.port}/v1`
  }

  enqueue(...turns: FakeTurn[]): void {
    this.turns.push(...turns)
  }

  release(id: string): void {
    const gate = this.holds.get(id)
    if (!gate) {
      throw new Error(`unknown hold: ${id}`)
    }
    gate.resolve()
  }

  async waitForRequestCount(count: number, timeoutMs = 5_000): Promise<void> {
    await this.waitUntil(() => this.requests.length >= count, timeoutMs, `request count >= ${count}`)
  }

  async waitForAbortCount(count: number, timeoutMs = 5_000): Promise<void> {
    await this.waitUntil(
      () => this.requests.filter(request => request.aborted).length >= count,
      timeoutMs,
      `aborted request count >= ${count}`
    )
  }

  async close(): Promise<void> {
    for (const gate of this.holds.values()) {
      gate.resolve()
    }
    this.holds.clear()
    for (const socket of this.sockets) {
      socket.destroy()
    }
    await new Promise<void>(resolve => {
      this.server.close(() => resolve())
    })
  }

  private async waitUntil(
    predicate: () => boolean,
    timeoutMs: number,
    description: string
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for ${description}`)
      }
      await delay(25)
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    let body: JsonObject
    try {
      body = await readJson(req)
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error) } }))
      return
    }

    const record: RecordedRequest = {
      path: req.url,
      body,
      aborted: false
    }
    this.requests.push(record)

    const turn = this.turns.shift() ?? { kind: 'text', text: 'NOVA_E2E_DEFAULT' }

    if (turn.kind === 'error') {
      res.writeHead(turn.status, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          turn.body ?? {
            error: {
              message: `fake provider error ${turn.status}`
            }
          }
        )
      )
      return
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })

    let finished = false
    res.on('close', () => {
      if (!finished) record.aborted = true
    })

    try {
      if (turn.kind === 'text') {
        const chunks = turn.chunks ?? [turn.text]
        for (const chunk of chunks) {
          if (turn.chunkDelayMs) await delay(turn.chunkDelayMs)
          if (res.destroyed) return
          writeSse(res, contentChunk(chunk))
        }
        writeSse(res, finishChunk())
        writeSse(res, '[DONE]')
        finished = true
        res.end()
        return
      }

      if (turn.kind === 'tool') {
        writeSse(res, {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: turn.callId ?? 'call_e2e',
                    type: 'function',
                    function: {
                      name: turn.name,
                      arguments: JSON.stringify(turn.arguments)
                    }
                  }
                ]
              },
              finish_reason: null
            }
          ]
        })
        writeSse(res, finishChunk('tool_calls'))
        writeSse(res, '[DONE]')
        finished = true
        res.end()
        return
      }

      if (turn.kind === 'hold') {
        const gate = createDeferred()
        this.holds.set(turn.id, gate)
        writeSse(res, contentChunk(''))
        await gate.promise
        this.holds.delete(turn.id)
        if (res.destroyed) return
        writeSse(res, contentChunk(turn.text))
        writeSse(res, finishChunk())
        writeSse(res, '[DONE]')
        finished = true
        res.end()
        return
      }

      for (const event of turn.events) {
        if (event.delayMs) await delay(event.delayMs)
        if (res.destroyed) return
        writeSse(res, event.payload)
      }
      if (!turn.events.some(event => event.payload === '[DONE]')) {
        writeSse(res, '[DONE]')
      }
      finished = true
      res.end()
    } catch (error) {
      if (!res.destroyed) {
        res.destroy(error as Error)
      }
    }
  }
}

export async function startFakeRuntime(): Promise<FakeRuntime> {
  return FakeRuntime.start()
}
