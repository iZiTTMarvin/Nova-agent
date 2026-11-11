import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { EvidenceAwareMockModelClient } from './EvidenceAwareMockModelClient'
import { COMPILE_OUTPUT_SCHEMA_VERSION } from '../../../../src/runtime/learning/build/compileOutputSchema'
import { SkeletonKnowledgeBuild } from '../../../../src/runtime/learning/build/SkeletonKnowledgeBuild'
import { WorkspaceEvidencePort, verifyFragmentAgainstDisk } from '../../../../src/runtime/learning/knowledge/evidence/WorkspaceEvidencePort'
import { validateCompileCandidate } from '../../../../src/runtime/learning/knowledge/validation/validateCompileCandidate'
import { parseCompileOutputText } from '../../../../src/runtime/learning/build/compileOutputSchema'
import { selectFragmentWindow } from '../../../../src/runtime/learning/knowledge/evidence/evidenceStrategy'
import {
  LEARNING_COMPILE_OUTPUT_RESERVE_TOKENS,
  LEARNING_MAX_COMPILE_OUTPUT_BYTES,
  LEARNING_SKELETON_INPUT_TOKEN_CAP
} from '../../../../src/shared/learning/buildLimits'
import { estimateTextTokens } from '../../../../src/shared/model/tokenEstimate'
import { createLearningDbHarness, learningWorkerJs } from '../../../integration/learning/learningTestHarness'
import { writeLargeProjectFixture, writeLedgerFixture } from './knowledgeBuild.fixture'
import type { EvidencePackage } from '../../../../src/runtime/learning/knowledge/evidence/evidenceTypes'

function compileJsonFromEvidence(
  evidence: EvidencePackage,
  mutate?: (nodes: Record<string, unknown>[]) => void,
  sourcePrefix = ''
): string {
  const saveFragment = sourcePrefix
    ? evidence.fragments.find(f => f.relativePath.startsWith(sourcePrefix))
    : evidence.fragments.find(f => f.relativePath.endsWith('save.ts'))
  if (!saveFragment) throw new Error('fixture 缺少可引用的片段')
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
          missingEvidence: '无'
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
    const builder = new SkeletonKnowledgeBuild()
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

  it('模型返回包裹在 ```json 围栏中且包含四类 claim 时，单次调用直接编译通过', async () => {
    const { harness, workspace } = await openHarness()
    try {
      const builder = new SkeletonKnowledgeBuild()
      const mock = new EvidenceAwareMockModelClient(evidence => {
        const rawJson = compileJsonFromEvidence(evidence, nodes => {
          const firstFact = (nodes[0]!.claims as Array<{ sourceIds?: string[] }>)[0]!
          const sourceIds = firstFact.sourceIds ?? []
          nodes[0] = {
            ...nodes[0]!,
            claims: [
              {
                kind: 'source_fact',
                text: '保存前先校验金额与备注',
                sourceIds
              },
              {
                kind: 'inference',
                text: '优先在入口处拦截脏数据以简化持久化层',
                sourceIds,
                uncertainty: '设计文档未显式记载该取舍'
              },
              {
                kind: 'general_explanation',
                text: '前置参数校验通常用于缩小写入事务失败面'
              },
              {
                kind: 'unverified',
                question: '并发写入时是否有跨进程文件锁？',
                missingEvidence: '当前片段未覆盖底层文件锁实现'
              }
            ]
          }
        })
        return `\`\`\`json\n${rawJson}\n\`\`\``
      })

      const result = await builder.run({
        workspaceRoot: workspace,
        modelClient: mock,
        knowledge: harness.knowledge,
        reader: harness.reader,
        focusRelativePaths: ['src/save.ts', 'src/index.ts']
      })

      expect(result).toMatchObject({ ok: true, modelCallCount: 1 })
      expect(mock.calls).toHaveLength(1)

      const promptPayload = JSON.parse(String(mock.calls[0]?.messages[0]?.content ?? '{}')) as {
        outputContract: { nodes: Array<{ claims: Array<{ kind: string }> }> }
      }
      expect(promptPayload.outputContract.nodes[0]?.claims.map(c => c.kind)).toEqual([
        'source_fact',
        'inference',
        'general_explanation',
        'unverified'
      ])

      const material = await harness.reader.getNodeMaterial(workspace, 'flow-save')
      const body = JSON.parse(material?.bodyJson ?? '{}') as { claims: Array<{ kind: string }> }
      expect(body.claims.map(c => c.kind)).toEqual([
        'source_fact',
        'inference',
        'general_explanation',
        'unverified'
      ])
    } finally {
      await harness.close()
    }
  })

  it.each([200_000, 32_000, 24_000])('约 1500 个文件的项目：窗口 %i 下请求不超预算，覆盖多个目录，片段不从 import 开始', async contextWindow => {
    const { harness } = await openHarness()
    const workspace = join(tempDir, 'large')
    writeLargeProjectFixture(workspace)
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence, undefined, 'src/'), contextWindow)
    const result = await new SkeletonKnowledgeBuild().run({
      workspaceRoot: workspace, modelClient: mock, knowledge: harness.knowledge, reader: harness.reader
    })
    expect(result.ok).toBe(true)
    expect(mock.calls).toHaveLength(1)
    const budget = Math.min(LEARNING_SKELETON_INPUT_TOKEN_CAP, contextWindow - LEARNING_COMPILE_OUTPUT_RESERVE_TOKENS)
    expect(estimateTextTokens(JSON.stringify(mock.calls[0]!.messages))).toBeLessThanOrEqual(budget)

    const payload = JSON.parse(String(mock.calls[0]!.messages[0]!.content)) as {
      evidenceFragments: { path: string; startLine: number; snippet: string }[]
      projectLayout: { dir: string; fileCount: number }[]
    }
    const codeFragments = payload.evidenceFragments.filter(f => /\.(ts|tsx)$/.test(f.path))
    const groups = new Set(codeFragments.map(f => f.path.split('/').slice(0, 2).join('/')))
    expect(groups.size).toBeGreaterThanOrEqual(4)
    for (const fragment of codeFragments) {
      expect(fragment.snippet.split('\n')[0]).not.toMatch(/^\s*import\b/)
      expect(fragment.path).not.toMatch(/(^|\/)tests\//)
    }
    expect(payload.projectLayout.some(entry => entry.dir === 'src')).toBe(true)
    await harness.close()
  }, 60_000)

  it('上下文太小的模型直接失败，不发出请求', async () => {
    const { harness, workspace } = await openHarness()
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence), 16_000)
    const result = await new SkeletonKnowledgeBuild().run({
      workspaceRoot: workspace, modelClient: mock, knowledge: harness.knowledge, reader: harness.reader
    })
    expect(result).toMatchObject({ ok: false, code: 'context_too_small', modelCallCount: 0 })
    expect(mock.calls).toHaveLength(0)
    await harness.close()
  })

  it('片段范围外的改动不算出处失效，范围内的改动算', async () => {
    const { harness, workspace } = await openHarness()
    const evidence = await new WorkspaceEvidencePort().collectSkeletonEvidence({ workspaceRoot: workspace })
    const index = evidence.fragments.find(f => f.relativePath === 'src/index.ts')!
    // import 行不在片段里
    expect(index.startLine).toBeGreaterThan(1)
    const path = join(workspace, 'src', 'index.ts')
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, original.replace("from './save'", "from './save' // 调整引用"), 'utf8')
    expect(await verifyFragmentAgainstDisk(workspace, index)).toBe(true)
    writeFileSync(path, original.replace('validateEntry(raw)', 'validateEntry({ ...raw })'), 'utf8')
    expect(await verifyFragmentAgainstDisk(workspace, index)).toBe(false)
    await harness.close()
  })

  it('无模型时已发布大纲可读且不发起 chat', async () => {
    const { harness, workspace } = await openHarness()
    const before = await harness.reader.getTreeProjection(workspace)
    expect(before.knowledgeRevision).toBeNull()

    const builder = new SkeletonKnowledgeBuild()
    const mock = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))
    await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })

    const noModel = await builder.run({
      workspaceRoot: workspace,
      modelClient: null,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(noModel).toMatchObject({ ok: false, code: 'no_model', modelCallCount: 0 })

    const after = await harness.reader.getTreeProjection(workspace)
    expect(after.nodes.some(n => n.nodeId === 'flow-save')).toBe(true)
    await harness.close()
  })

  it('源码变化后旧候选不能发布；last-good 仍在', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild()
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

  it.each([false, true])('重复节点进入有界修复，持续重复=%s 时保留最后可用版本', async persistent => {
    const { harness, workspace } = await openHarness()
    try {
      const builder = new SkeletonKnowledgeBuild()
      const baseline = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence))
      expect(await builder.run({ workspaceRoot: workspace, modelClient: baseline, knowledge: harness.knowledge, reader: harness.reader })).toMatchObject({ ok: true })
      const before = await harness.reader.getCurrentKnowledgeRevision(workspace)
      let attempts = 0
      const model = new EvidenceAwareMockModelClient(evidence => compileJsonFromEvidence(evidence, nodes => {
        if (++attempts === 1 || persistent) nodes.push({ ...nodes[0]! })
      }))

      const result = await builder.run({ workspaceRoot: workspace, modelClient: model, knowledge: harness.knowledge, reader: harness.reader })
      expect(result).toMatchObject({ ok: !persistent, modelCallCount: 2 })
      expect(model.calls[1]?.messages).toContainEqual({ role: 'user', content: expect.stringContaining('nodeId 重复') })
      const after = await harness.reader.getCurrentKnowledgeRevision(workspace)
      if (persistent) {
        expect(result).toMatchObject({ code: 'invalid_output' })
        expect(after).toBe(before)
      } else {
        expect(after).not.toBe(before)
      }
      expect((await harness.reader.getTreeProjection(workspace)).nodes.map(node => node.nodeId)).toEqual(['flow-save'])
    } finally {
      await harness.close()
    }
  })

  it('模型生成期间出处变化直接返回 source_changed，不请求输出修复', async () => {
    const { harness, workspace } = await openHarness()
    try {
      const model = new EvidenceAwareMockModelClient(evidence => {
        writeFileSync(join(workspace, 'src', 'save.ts'), 'export const changed = true\n', 'utf8')
        return compileJsonFromEvidence(evidence)
      })
      const result = await new SkeletonKnowledgeBuild().run({ workspaceRoot: workspace, modelClient: model, knowledge: harness.knowledge, reader: harness.reader })
      expect(result).toMatchObject({ ok: false, code: 'source_changed', modelCallCount: 1 })
      expect(await harness.reader.getCurrentKnowledgeRevision(workspace)).toBeNull()
    } finally {
      await harness.close()
    }
  })

  it('未知 sourceId 拒绝发布', async () => {
    const { harness, workspace } = await openHarness()
    const evidence = await new WorkspaceEvidencePort().collectSkeletonEvidence({
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
    const evidence = await new WorkspaceEvidencePort().collectSkeletonEvidence({
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
    const port = new WorkspaceEvidencePort()
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
    const evidence = await new WorkspaceEvidencePort().collectSkeletonEvidence({
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
    const builder = new SkeletonKnowledgeBuild()
    const mock = new MockModelClient()
    mock.addResponse({ events: [{ type: 'text_delta', delta: 'not-json' }] })
    mock.addResponse({ events: [{ type: 'text_delta', delta: '{ broken' }] })

    const result = await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(result).toMatchObject({ ok: false, code: 'invalid_output', modelCallCount: 2 })
    expect(mock.getCalls()).toHaveLength(2)
    expect(await harness.reader.getCurrentKnowledgeRevision(workspace)).toBeNull()
    expect((await harness.reader.getTreeProjection(workspace)).nodes).toHaveLength(0)
    await harness.close()
  })

  it('模型请求失败按 provider_error 上报，不退化成 schema 无效也不空转修复', async () => {
    const { harness, workspace } = await openHarness()
    const builder = new SkeletonKnowledgeBuild()
    const mock = new MockModelClient()
    mock.addResponse({ events: [{ type: 'error', error: 'fake provider error 500' }] })

    const result = await builder.run({
      workspaceRoot: workspace,
      modelClient: mock,
      knowledge: harness.knowledge,
      reader: harness.reader
    })
    expect(result).toMatchObject({ ok: false, code: 'provider_error', modelCallCount: 1 })
    expect(mock.getCalls()).toHaveLength(1)
    expect(await harness.reader.getCurrentKnowledgeRevision(workspace)).toBeNull()
    await harness.close()
  })

  it.each([
    {
      name: 'Python 带行尾注释的导入',
      content: 'import os  # environment\n\ndef run():\n    return 42\n',
      startLine: 3,
      symbolLabel: 'run'
    },
    {
      name: 'Java 静态导入',
      content: 'package app;\nimport static java.lang.Math.*;\npublic class Main {\n}\n',
      startLine: 3,
      symbolLabel: 'Main'
    },
    {
      name: 'TypeScript 跨行导入',
      content: "import Default, {\ntype Token,\nhelper,\n} from './dependency'\nexport const run = () => helper(Default)\n",
      startLine: 5,
      symbolLabel: 'run'
    }
  ])('$name 不会吞掉后续源码正文', ({ content, startLine, symbolLabel }) => {
    expect(selectFragmentWindow('code', content)).toMatchObject({
      startLine,
      symbolLabel,
      text: content.split('\n').slice(startLine - 1).join('\n')
    })
  })

  it('多语言工作区可抽取代码片段与顶层符号，且非 JS 越界路径同样被拦截', async () => {
    const { harness } = await openHarness()
    const pyWorkspace = join(tempDir, 'py-ws')
    mkdirSync(join(pyWorkspace, 'app'), { recursive: true })
    writeFileSync(
      join(pyWorkspace, 'pyproject.toml'),
      '[project]\nname = "demo-service"\nversion = "0.1.0"\n',
      'utf8'
    )
    writeFileSync(join(pyWorkspace, 'README.md'), '# Demo Python Service\n', 'utf8')
    writeFileSync(
      join(pyWorkspace, 'main.py'),
      [
        '#!/usr/bin/env python3',
        '# 入口启动注释',
        '"""模块说明文档"""',
        'import os  # 读取运行环境',
        'from app.service import OrderProcessor',
        '',
        'async def run_server() -> None:',
        '    processor = OrderProcessor(os.getenv("ENV", "dev"))',
        '    processor.handle_order("ord-1")',
        ''
      ].join('\n'),
      'utf8'
    )
    writeFileSync(
      join(pyWorkspace, 'app', 'service.py'),
      [
        '# 业务处理层',
        'from dataclasses import dataclass',
        '',
        'class OrderProcessor:',
        '    def __init__(self, env: str) -> None:',
        '        self.env = env',
        '',
        '    def handle_order(self, order_id: str) -> str:',
        '        return f"{self.env}:{order_id}"',
        ''
      ].join('\n'),
      'utf8'
    )
    mkdirSync(join(pyWorkspace, 'gateway'), { recursive: true })
    writeFileSync(
      join(pyWorkspace, 'gateway', 'server.go'),
      [
        'package gateway',
        '',
        'import (',
        '\t"fmt"',
        '\t"net/http"',
        ')',
        '',
        'func (s *Server) Start(addr string) error {',
        '\tfmt.Println(addr)',
        '\treturn http.ListenAndServe(addr, nil)',
        '}',
        ''
      ].join('\n'),
      'utf8'
    )
    mkdirSync(join(pyWorkspace, 'core'), { recursive: true })
    writeFileSync(
      join(pyWorkspace, 'core', 'lib.rs'),
      [
        'use std::collections::HashMap;',
        '',
        '#[derive(Debug, Clone)]',
        'pub struct EngineConfig {',
        '    pub routes: HashMap<String, String>,',
        '}',
        ''
      ].join('\n'),
      'utf8'
    )
    mkdirSync(join(pyWorkspace, 'java'), { recursive: true })
    writeFileSync(
      join(pyWorkspace, 'java', 'Main.java'),
      'package app;\nimport static java.lang.Math.*;\npublic class Main {\n}\n',
      'utf8'
    )

    const evidence = await new WorkspaceEvidencePort().collectSkeletonEvidence({
      workspaceRoot: pyWorkspace
    })
    const mainFrag = evidence.fragments.find(f => f.relativePath === 'main.py')
    const serviceFrag = evidence.fragments.find(f => f.relativePath === 'app/service.py')
    const goFrag = evidence.fragments.find(f => f.relativePath === 'gateway/server.go')
    const rustFrag = evidence.fragments.find(f => f.relativePath === 'core/lib.rs')
    const javaFrag = evidence.fragments.find(f => f.relativePath === 'java/Main.java')
    expect(mainFrag).toBeDefined()
    expect(mainFrag?.symbolLabel).toBe('run_server')
    expect(mainFrag?.startLine).toBe(7)
    expect(mainFrag?.snippetText).toContain('async def run_server()')
    expect(serviceFrag).toBeDefined()
    expect(serviceFrag?.symbolLabel).toBe('OrderProcessor')
    expect(serviceFrag?.startLine).toBe(4)
    expect(goFrag?.symbolLabel).toBe('Start')
    expect(goFrag?.startLine).toBe(8)
    expect(rustFrag?.symbolLabel).toBe('EngineConfig')
    expect(rustFrag?.startLine).toBe(4)
    expect(javaFrag).toMatchObject({ startLine: 3, symbolLabel: 'Main' })

    const leakCandidate = parseCompileOutputText(
      compileJsonFromEvidence(
        evidence,
        nodes => {
          nodes[0] = {
            ...nodes[0]!,
            summary: '读取 ../outside/secret_config.py 初始化环境'
          }
        },
        'app/'
      )
    )
    const leakValidation = await validateCompileCandidate({
      workspaceRoot: pyWorkspace,
      evidence,
      output: leakCandidate
    })
    expect(leakValidation.ok).toBe(false)
    if (!leakValidation.ok) expect(leakValidation.failure.code).toBe('out_of_bounds_path')

    await harness.close()
  })
})
