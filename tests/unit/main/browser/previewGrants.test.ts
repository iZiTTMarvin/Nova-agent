import { describe, expect, it } from 'vitest'
import { createPreviewGrantStore } from '../../../../src/main/browser/previewGrants'
import { findOwnedPreviewRef } from '../../../../src/main/browser/previewProcess'
import { ProcessRegistry } from '../../../../src/runtime/process'

describe('预览授权', () => {
  it('只绑定当前工作区和会话的确切 origin，外部服务器没有进程引用', () => {
    const store = createPreviewGrantStore({ findRunning: () => null })
    const confirmed = store.confirm({
      workspaceKey: 'ws',
      sessionId: 'sess',
      url: 'http://localhost:5173/index.html'
    })
    expect(confirmed.ok).toBe(true)
    if (!confirmed.ok || !confirmed.restricted) return
    expect(confirmed.grant.processRef).toBeNull()
    expect(store.grantedOrigins('ws', 'sess')).toEqual(['http://localhost:5173'])
    expect(store.grantedOrigins('ws', 'other')).toEqual([])
    expect(store.grantedOrigins('other', 'sess')).toEqual([])
  })

  it('命令行里的 origin 唯一命中才绑定，多个或没有都不猜', () => {
    expect(findOwnedPreviewRef([
      { ref: 'psn_a', command: 'vite http://127.0.0.1:5173' },
      { ref: 'psn_b', command: 'npm test' }
    ], 'http://127.0.0.1:5173')).toBe('psn_a')
    expect(findOwnedPreviewRef([
      { ref: 'psn_a', command: 'vite http://127.0.0.1:5173' },
      { ref: 'psn_b', command: 'also http://127.0.0.1:5173' }
    ], 'http://127.0.0.1:5173')).toBeNull()
    expect(findOwnedPreviewRef([
      { ref: 'psn_a', command: 'npm run dev' }
    ], 'http://127.0.0.1:5173')).toBeNull()
  })

  it('登记表只提供只读列表，确认预览不会把进程标成退出', () => {
    const registry = new ProcessRegistry({ terminateTimeoutMs: 20 })
    let kills = 0
    const handle = registry.register({
      owner: { sessionId: 'sess', runId: 'run' },
      source: 'main-run',
      command: 'dev http://127.0.0.1:4173',
      workdir: 'D:/workspace',
      destructive: false,
      seedOutput: '',
      killTree: async () => {
        kills += 1
      },
      writeStdin: async () => {},
      child: { exitCode: null, signalCode: null, once() {} },
      checkpointBaseline: null
    })
    const store = createPreviewGrantStore({
      findRunning: (sessionId, origin) => findOwnedPreviewRef(registry.listRunning(sessionId), origin)
    })
    const confirmed = store.confirm({
      workspaceKey: 'ws',
      sessionId: 'sess',
      url: 'http://127.0.0.1:4173/'
    })
    expect(confirmed).toMatchObject({
      ok: true,
      restricted: true,
      grant: { processRef: handle.ref }
    })
    expect(kills).toBe(0)
    expect(registry.describe(handle.ref, 'sess').state).toBe('running')
    expect(registry.listRunning('other')).toEqual([])
  })
})
