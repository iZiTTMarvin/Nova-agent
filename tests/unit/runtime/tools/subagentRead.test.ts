import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { SessionStore, deriveChildSessionId } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { subagentReadTool } from '../../../../src/runtime/tools/subagentRead'

let root: string

beforeEach(() => {
  resetSessionIndexHostForTests()
  root = mkdtempSync(join(tmpdir(), 'nova-subagent-read-'))
})

afterEach(() => {
  resetSessionIndexHostForTests()
  rmSync(root, { recursive: true, force: true })
})

function createChild(
  store: SessionStore,
  parentSessionId: string,
  spawnKey: string,
  task = 'inspect auth runtime'
) {
  return store.createChildIfAbsent({
    childSessionId: deriveChildSessionId(spawnKey),
    workspaceRoot: resolve(root, 'workspace'),
    mode: 'default',
    permissionMode: 'request_approval',
    task,
    subagent: {
      lineage: {
        parentSessionId,
        parentRunId: `run-parent-${spawnKey}`,
        rootRunId: `run-root-${spawnKey}`,
        depth: 1,
        spawnKey,
        spawnRunId: '11111111-2222-3333-4444-555555555555',
        origin: {
          kind: 'task_tool',
          parentMessageId: `msg-parent-${spawnKey}`,
          parentToolCallId: `call-task-${spawnKey}`
        }
      },
      profile: {
        profileId: 'explore',
        name: 'explore',
        description: 'read only',
        systemPrompt: 'inspect evidence',
        toolNames: ['read', 'grep'],
        permissionCeiling: 'read_only',
        maxToolRounds: 20,
        configHash: 'a'.repeat(64)
      }
    }
  }).session
}

function context(
  store: SessionStore,
  sessionId: string,
  artifactStore?: ArtifactStore
) {
  return {
    workingDir: resolve(root, 'workspace'),
    readState: createReadState(),
    sessionStore: store,
    sessionId,
    ...(artifactStore ? { artifactStore } : {})
  }
}

describe('subagent_read', () => {
  it('从权威 child session 回读摘要之外的原始工具证据，并保留 toolCall 来源', async () => {
    const store = new SessionStore(root)
    const parent = store.create(resolve(root, 'workspace'))
    const child = createChild(store, parent.id, 'task_tool:evidence')
    const evidence = `${'x'.repeat(9_000)}REFRESH_RACE_EVIDENCE`

    const append = store.appendMessageFast(child.id, {
      id: 'msg-child-final',
      role: 'assistant',
      content: '发现 refresh token 并发覆盖。',
      toolCalls: [{
        id: 'call-read-auth',
        name: 'read',
        arguments: '{"path":"src/auth.ts"}',
        result: evidence
      }],
      timestamp: 2
    })
    expect(append.ok).toBe(true)

    const search = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'search',
        query: 'REFRESH_RACE_EVIDENCE'
      },
      context(store, parent.id)
    )

    expect(search.success).toBe(true)
    const payload = JSON.parse(search.output)
    expect(payload.totalMatches).toBe(1)
    expect(payload.matches[0].offset).toBeGreaterThan(8_000)
    expect(payload.matches[0].snippet).toContain('REFRESH_RACE_EVIDENCE')

    const sourceSearch = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'search',
        query: 'call-read-auth'
      },
      context(store, parent.id)
    )
    expect(sourceSearch.success).toBe(true)
    expect(sourceSearch.output).toContain('name=read')
    expect(sourceSearch.output).toContain('src/auth.ts')
  })

  it('能在验证 child 归属与 toolCall 引用后读取 child 自己 spill 的大输出 artifact', async () => {
    const store = new SessionStore(root)
    const parent = store.create(resolve(root, 'workspace'))
    const child = createChild(store, parent.id, 'task_tool:artifact')
    const artifactStore = new ArtifactStore(join(root, 'sessions'))
    const rawEvidence = `${'z'.repeat(60_000)}FULL_CHILD_ARTIFACT_EVIDENCE`
    const artifact = await artifactStore.write(child.id, rawEvidence, {
      toolName: 'grep',
      truncated: true
    })
    const unreferenced = await artifactStore.write(child.id, 'internal-only', {
      toolName: 'internal',
      truncated: false
    })

    const append = store.appendMessageFast(child.id, {
      id: 'msg-child-artifact',
      role: 'assistant',
      content: '大输出已经落盘。',
      toolCalls: [{
        id: 'call-grep-large',
        name: 'grep',
        arguments: '{"pattern":"race"}',
        result: `[输出已截断]\n完整输出: artifact://${artifact.id}`,
        artifactId: artifact.id
      }],
      timestamp: 2
    })
    expect(append.ok).toBe(true)

    const inspect = await subagentReadTool.execute(
      { child_session_id: child.id, operation: 'inspect' },
      context(store, parent.id, artifactStore)
    )
    expect(inspect.success).toBe(true)
    expect(JSON.parse(inspect.output).artifactIds).toContain(artifact.id)
    expect(JSON.parse(inspect.output).artifactIds).not.toContain(unreferenced.id)

    const sourceSearch = await subagentReadTool.execute(
      { child_session_id: child.id, operation: 'search', query: artifact.id },
      context(store, parent.id, artifactStore)
    )
    expect(sourceSearch.success).toBe(true)
    expect(sourceSearch.output).toContain('name=grep')
    expect(sourceSearch.output).toContain(`artifact=${artifact.id}`)

    const artifactRead = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'artifact_read',
        artifact_id: artifact.id,
        offset: 59_980,
        limit: 100
      },
      context(store, parent.id, artifactStore)
    )
    expect(artifactRead.success).toBe(true)
    const payload = JSON.parse(artifactRead.output)
    expect(payload.artifactId).toBe(artifact.id)
    expect(payload.content).toContain('FULL_CHILD_ARTIFACT_EVIDENCE')

    // 从 0 沿 nextOffset 读穿全文，证明 spill 原文完整可回读而非只有局部抽查
    let cursor = 0
    let collected = ''
    for (let page = 0; page < 10; page++) {
      const pageResult = await subagentReadTool.execute(
        {
          child_session_id: child.id,
          operation: 'artifact_read',
          artifact_id: artifact.id,
          offset: cursor,
          limit: 16_000
        },
        context(store, parent.id, artifactStore)
      )
      const pagePayload = JSON.parse(pageResult.output)
      expect(pagePayload.totalChars).toBe(rawEvidence.length)
      collected += pagePayload.content
      if (!pagePayload.hasMore) break
      cursor = pagePayload.nextOffset
    }
    expect(collected.length).toBe(rawEvidence.length)
    expect(collected.endsWith('FULL_CHILD_ARTIFACT_EVIDENCE')).toBe(true)

    const denied = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'artifact_read',
        artifact_id: unreferenced.id
      },
      context(store, parent.id, artifactStore)
    )
    expect(denied.success).toBe(false)
    expect(denied.error).toContain('未被该子代理当前 toolCall 记录引用')
  })

  it('拒绝读取不属于当前会话树的子代理', async () => {
    const store = new SessionStore(root)
    const parent = store.create(resolve(root, 'workspace-a'))
    const otherParent = store.create(resolve(root, 'workspace-b'))
    const foreignChild = createChild(store, otherParent.id, 'task_tool:foreign')

    const result = await subagentReadTool.execute(
      { child_session_id: foreignChild.id, operation: 'inspect' },
      context(store, parent.id)
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('只能读取当前会话派生出的子代理记录')
  })

  it('read 使用字符 offset 分页，能从 search 命中位置继续核对原文', async () => {
    const store = new SessionStore(root)
    const parent = store.create(resolve(root, 'workspace'))
    const child = createChild(store, parent.id, 'task_tool:paging')
    store.appendMessageFast(child.id, {
      id: 'msg-child-final',
      role: 'assistant',
      content: 'alpha EVIDENCE_TARGET omega',
      timestamp: 2
    })

    const search = await subagentReadTool.execute(
      { child_session_id: child.id, operation: 'search', query: 'EVIDENCE_TARGET' },
      context(store, parent.id)
    )
    const hit = JSON.parse(search.output).matches[0]

    const read = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'read',
        offset: Math.max(0, hit.offset - 6),
        limit: 40
      },
      context(store, parent.id)
    )

    expect(read.success).toBe(true)
    expect(JSON.parse(read.output).content).toContain('EVIDENCE_TARGET')
  })

  it('search 命中偏移与原文严格对齐，不受大小写折叠变长字符影响', async () => {
    const store = new SessionStore(root)
    const parent = store.create(resolve(root, 'workspace'))
    const child = createChild(store, parent.id, 'task_tool:unicode')
    store.appendMessageFast(child.id, {
      id: 'msg-child-unicode',
      role: 'assistant',
      content: `${'İ'.repeat(40)}EVIDENCE_OFFSET_TARGET`,
      timestamp: 2
    })

    const search = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'search',
        query: 'evidence_offset_target'
      },
      context(store, parent.id)
    )
    expect(search.success).toBe(true)
    const hit = JSON.parse(search.output).matches[0]
    // İ 在 toLowerCase 下从 1 个代码单元展开为 2 个；命中偏移若取自折叠副本，
    // 这里会向右漂移 40 字符、读不到目标原文
    const read = await subagentReadTool.execute(
      {
        child_session_id: child.id,
        operation: 'read',
        offset: hit.offset,
        limit: 30
      },
      context(store, parent.id)
    )
    const payload = JSON.parse(read.output)
    expect(payload.content.startsWith('EVIDENCE_OFFSET_TARGET')).toBe(true)
    expect(payload.content).not.toContain('İ')
  })

  it('不声明通用截断上限，长分页结果在执行器路径保持完整 JSON', () => {
    // 执行器对声明了 maxResultSizeChars 的结果按 1000 字符切长行；
    // 本工具输出是单行 JSON，被切即不可解析。单测直连 execute 覆盖不到该路径，
    // 在此钉住契约
    expect(subagentReadTool.maxResultSizeChars).toBeUndefined()
  })
})
