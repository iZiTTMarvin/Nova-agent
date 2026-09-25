import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { EvidenceAwareMockModelClient } from './EvidenceAwareMockModelClient'
import { COMPILE_OUTPUT_SCHEMA_VERSION } from '../../../../src/runtime/learning/build/compileOutputSchema'
import { SkeletonKnowledgeBuild } from '../../../../src/runtime/learning/build/SkeletonKnowledgeBuild'
import { WorkspaceEvidencePort } from '../../../../src/runtime/learning/knowledge/evidence/WorkspaceEvidencePort'
import { validateCompileCandidate } from '../../../../src/runtime/learning/knowledge/validation/validateCompileCandidate'
import { parseCompileOutputText } from '../../../../src/runtime/learning/build/compileOutputSchema'
import { LEARNING_MAX_COMPILE_OUTPUT_BYTES } from '../../../../src/shared/learning/buildLimits'
import { createLearningDbHarness, learningWorkerJs } from '../../../integration/learning/learningTestHarness'
import { writeLedgerFixture } from './knowledgeBuild.fixture'
import type { EvidencePackage } from '../../../../src/runtime/learning/knowledge/evidence/evidenceTypes'

function compileJsonFromEvidence(
  evidence: EvidencePackage,
  mutate?: (nodes: Record<string, unknown>[]) => void
): string {
  const saveFragment = evidence.fragments.find(f => f.relativePath.endsWith('save.ts'))
  if (!saveFragment) throw new Error('fixture 缺少 save.ts 片段')
  const nodes: Record<string, unknown>[] = [
    {
      nodeId: 'flow-save',
      title: '保存一笔账',
      summary: '校验输入后写入记录',
      learningGoal: '跟一遍保存路径',
      navDimension: 'key_user_flows',
      parentNodeId: null,
      claims: [
        {
          kind: 'source_fact',
          text: '保存前先校验金额与备注',
          sourceIds: [saveFragment.sourceId]
        },
        {
          kind: 'unverified',
          question: '未读文件里还有什么？',
          missingEvidence: evidence.unreadPaths.join(',') || '无'
        }
      ],
      prerequisiteNodeIds: [],
      relatedNodeIds: [],
      flowNextNodeIds: []
    }
  ]
  mutate?.(nodes)
  return JSON.stringify({ schemaVersion: COMPILE_OUTPUT_SCHEMA_VERSION, nodes })
}

describe('knowledge skeleton build', () => {
  let tempDir: string

  afterEach(() => {
    if (!tempDir) return
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch {
      // ignore
    }
  })

  async function openHarness() {
    if (!existsSync(learningWorkerJs)) {
      throw new Error(`缺少构建产物 ${learningWorkerJs}，请先 npm run build`)
    }
    tempDir = mkdtempSync(join(tmpdir(), 'nova-knowledge-build-'))
    const workspace = join(tempDir, 'ws')
    writeLedgerFixture(workspace)
    const dbPath = join(tempDir, 'learning.db')
    const harness = await createLearningDbHarness(dbPath)
    return { harness, workspace }
  }

  it('真实 fixture + fake ModelClient：流程节点有出处；模型无工具且输入仅证据包', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild(null)
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))

    const result = await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader,
      focusRelativePaths: ['src/save.ts', 'src/index.ts']
    })
    expect(result.ok).toBe(true)
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0]?.tools ?? []).toEqual([])
    const userContent = String(mock.calls[0]?.messages[0]?.content ?? '')
    expect(userContent).toContain('evidenceFragments')
    expect(userContent).not.toContain('node_modules')

    const material = await harness.reader.getNodeMaterial(workspace, 'flow-save')
    expect(material?.sources.length).toBeGreaterThan(0)
    expect(material?.sources[0]?.filePath).toContain('save.ts')

    const body = JSON.parse(material?.bodyJson ?? '{}')
    expect(body.claims.some((c: { kind: string }) => c.kind === 'unverified')).toBe(true)
    await harness.close()
  })

  it('未读文件在节点覆盖中标记为待核实', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild(null)
    const evidenceProbe = await builder.collectEvidenceOnly({ workspaceRoot: workspace })
    expect(evidenceProbe.unreadPaths.some(p => p.includes('unread.ts'))).toBe(true)

    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))
    await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    const material = await harness.reader.getNodeMaterial(workspace, 'flow-save')
    const body = JSON.parse(material?.bodyJson ?? '{}')
    const unverified = body.claims.find((c: { kind: string }) => c.kind === 'unverified')
    expect(unverified?.missingEvidence).toContain('unread.ts')
    await harness.close()
  })

  it('不注入 Code Index 仍能完成构建', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild(null)
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))
    const result = await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(result.ok).toBe(true)
    await harness.close()
  })

  it('无模型时导航与已发布材料可读且不发起 chat', async () => {
    const { harness, workspace } = await openHarness()
    const before = await harness.surface.loadView(workspace)
    expect(before.navigation.dimensions).toHaveLength(6)
    expect(before.tree.knowledgeRevision).toBeNull()

    const builder = new SkeletonKnowledgeBuild(null)
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))
    await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })

    const mock2 = new MockModelClient()
    const noModel = await builder.run({
      workspaceRoot: workspace,
      modelClient: null,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(noModel.ok).toBe(false)
    expect(mock2.getCalls()).toHaveLength(0)

    const after = await harness.surface.loadView(workspace)
    expect(after.navigation.hasPublishedNodes).toBe(true)
    expect(after.tree.nodes.some(n => n.nodeId === 'flow-save')).toBe(true)
    await harness.close()
  })

  it('源码变化后旧候选不能发布；last-good 仍在', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild(null)
    const evidenceBefore = await builder.collectEvidenceOnly({ workspaceRoot: workspace })
    const mock = new MockModelClient()
    mock.addResponse({
      events: [{ type: 'text_delta', delta: compileJsonFromEvidence(evidenceBefore) }]
    })
    await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    const revisionBefore = await harness.reader.getCurrentKnowledgeRevision(workspace)

    writeFileSync(join(workspace, 'src', 'save.ts'), 'export const changed = true\n', 'utf8')
    const output = parseCompileOutputText(compileJsonFromEvidence(evidenceBefore))
    const validation = await validateCompileCandidate({
      workspaceRoot: workspace,
      evidence: evidenceBefore,
      output
    })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.failure.code).toBe('stale_source')
    expect(await harness.reader.getCurrentKnowledgeRevision(workspace)).toBe(revisionBefore)
    await harness.close()
  })

  it('未知 sourceId 拒绝发布', async () => {
    const { harness, workspace } = await openHarness()
    const evidence = await new WorkspaceEvidencePort(null).collectSkeletonEvidence({
      workspaceRoot: workspace
    })
    const output = parseCompileOutputText(
      compileJsonFromEvidence(evidence, nodes => {
        nodes[0] = {
          ...nodes[0]!,
          claims: [{ kind: 'source_fact', text: '伪造', sourceIds: ['00000000-0000-4000-8000-000000000000'] }]
        }
      })
    )
    const validation = await validateCompileCandidate({ workspaceRoot: workspace, evidence, output })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.failure.code).toBe('unknown_source_id')
    await harness.close()
  })

  it('树环拒绝发布', async () => {
    const { harness, workspace } = await openHarness()
    const evidence = await new WorkspaceEvidencePort(null).collectSkeletonEvidence({
      workspaceRoot: workspace
    })
    const output = parseCompileOutputText(
      compileJsonFromEvidence(evidence, nodes => {
        nodes.push({
          nodeId: 'b',
          title: 'B',
          summary: '',
          learningGoal: '',
          navDimension: null,
          parentNodeId: 'flow-save',
          claims: [],
          prerequisiteNodeIds: [],
          relatedNodeIds: [],
          flowNextNodeIds: []
        })
        nodes[0] = { ...nodes[0]!, parentNodeId: 'b' }
      })
    )
    const validation = await validateCompileCandidate({ workspaceRoot: workspace, evidence, output })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.failure.code).toBe('tree_cycle')
    await harness.close()
  })

  it('越界路径：取证不读工作区外；模型引用越界路径拒绝', async () => {
    const { harness, workspace } = await openHarness()
    const port = new WorkspaceEvidencePort(null)
    await expect(
      port.collectSkeletonEvidence({ workspaceRoot: workspace })
    ).resolves.toBeDefined()

    const evidence = await port.collectSkeletonEvidence({ workspaceRoot: workspace })
    const output = parseCompileOutputText(
      compileJsonFromEvidence(evidence, nodes => {
        nodes[0] = {
          ...nodes[0]!,
          summary: '引用 ../outside/leak.ts 作为依据'
        }
      })
    )
    const validation = await validateCompileCandidate({ workspaceRoot: workspace, evidence, output })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.failure.code).toBe('out_of_bounds_path')

    const windowsOutput = parseCompileOutputText(
      compileJsonFromEvidence(evidence, nodes => {
        nodes[0] = {
          ...nodes[0]!,
          summary: '引用 ..\\outside\\leak.ts 与 C:\\secret.ts'
        }
      })
    )
    const windowsValidation = await validateCompileCandidate({
      workspaceRoot: workspace,
      evidence,
      output: windowsOutput
    })
    expect(windowsValidation.ok).toBe(false)
    if (!windowsValidation.ok) expect(windowsValidation.failure.code).toBe('out_of_bounds_path')
    await harness.close()
  })

  it('没有 sourceId 的 source_fact 不能发布为已核实', async () => {
    const { harness, workspace } = await openHarness()
    const evidence = await new WorkspaceEvidencePort(null).collectSkeletonEvidence({
      workspaceRoot: workspace
    })
    const output = parseCompileOutputText(
      compileJsonFromEvidence(evidence, nodes => {
        nodes[0] = {
          ...nodes[0]!,
          claims: [{ kind: 'source_fact', text: '没有出处的事实', sourceIds: [] }]
        }
      })
    )
    const validation = await validateCompileCandidate({ workspaceRoot: workspace, evidence, output })
    expect(validation.ok).toBe(false)
    if (!validation.ok) expect(validation.failure.code).toBe('unknown_source_id')
    await harness.close()
  })

  it('超预算输出拒绝发布', () => {
    const huge = 'x'.repeat(LEARNING_MAX_COMPILE_OUTPUT_BYTES + 16)
    expect(() =>
      parseCompileOutputText(JSON.stringify({ schemaVersion: 1, nodes: [], pad: huge }))
    ).toThrow(/字节上限/)
  })

  it('schema 修复耗尽：两次非法输出共 2 次模型调用且不发布', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild(null)
    const mock = new MockModelClient()
    mock.addResponse({ events: [{ type: 'text_delta', delta: 'not-json' }] })
    mock.addResponse({ events: [{ type: 'text_delta', delta: '{ broken' }] })

    const result = await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(result.ok).toBe(false)
    expect(result.modelCallCount).toBe(2)
    expect(mock.getCalls()).toHaveLength(2)
    expect(await harness.reader.getCurrentKnowledgeRevision(workspace)).toBeNull()
    const view = await harness.surface.loadView(workspace)
    expect(view.navigation.hasPublishedNodes).toBe(false)
    await harness.close()
  })
})
