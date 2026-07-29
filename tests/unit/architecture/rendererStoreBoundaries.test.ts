import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildViolationsForEdge,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_RENDERER_IMPLEMENTATION,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_SLICES,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_STORE_ROOT,
  RULE_CHAT_SLICE_CANNOT_IMPORT_STORE_ROOT,
  RULE_CHAT_SLICE_CANNOT_IMPORT_LEGACY_STORE_TYPES,
  RULE_CHAT_SLICE_CANNOT_IMPORT_RENDERER_UI,
  RULE_CHAT_SLICES_CANNOT_IMPORT_EACH_OTHER,
  RULE_COMPONENTS_CANNOT_IMPORT_CHAT_INTERNALS,
  type BoundaryViolation
} from './importBoundaryRules'
import { findRepoRoot, scanSourceTree } from './importBoundaryScanner'

const CHAT_SLICE_RULES = [
  RULE_CHAT_SLICE_CANNOT_IMPORT_STORE_ROOT,
  RULE_CHAT_SLICES_CANNOT_IMPORT_EACH_OTHER,
  RULE_CHAT_SLICE_CANNOT_IMPORT_LEGACY_STORE_TYPES,
  RULE_CHAT_SLICE_CANNOT_IMPORT_RENDERER_UI,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_SLICES,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_STORE_ROOT,
  RULE_CHAT_INTERNAL_CANNOT_IMPORT_RENDERER_IMPLEMENTATION,
  RULE_COMPONENTS_CANNOT_IMPORT_CHAT_INTERNALS
] as const

function expectOnlyRule(violations: BoundaryViolation[], rule: string): void {
  expect(violations.map((violation) => violation.rule)).toEqual([rule])
}

describe('renderer chat store boundaries', () => {
  it('slice 不能依赖 store facade 或组装入口', () => {
    for (const target of [
      'src/renderer/stores/useChatStore.ts',
      'src/renderer/stores/chat/index.ts',
      'src/renderer/stores/chat/createChatStore.ts'
    ]) {
      expectOnlyRule(
        buildViolationsForEdge(
          'src/renderer/stores/chat/slices/messageSlice.ts',
          target,
          '../index'
        ),
        RULE_CHAT_SLICE_CANNOT_IMPORT_STORE_ROOT
      )
    }
  })

  it('slice 不能依赖其他 slice 或 slices barrel', () => {
    for (const target of [
      'src/renderer/stores/chat/slices/sessionSlice.ts',
      'src/renderer/stores/chat/slices/index.ts'
    ]) {
      expectOnlyRule(
        buildViolationsForEdge(
          'src/renderer/stores/chat/slices/messageSlice.ts',
          target,
          './sessionSlice'
        ),
        RULE_CHAT_SLICES_CANNOT_IMPORT_EACH_OTHER
      )
    }
  })

  it('slice 不能反向依赖 Renderer UI 实现', () => {
    for (const target of [
      'src/renderer/App.tsx',
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/features/chat/partialJsonArgs.ts'
    ]) {
      expectOnlyRule(
        buildViolationsForEdge(
          'src/renderer/stores/chat/slices/streamSlice.ts',
          target,
          '../../../features/chat/partialJsonArgs'
        ),
        RULE_CHAT_SLICE_CANNOT_IMPORT_RENDERER_UI
      )
    }
  })

  it('slice 只能从 chat 契约读取 Store 类型', () => {
    expectOnlyRule(
      buildViolationsForEdge(
        'src/renderer/stores/chat/slices/streamSlice.ts',
        'src/renderer/stores/types.ts',
        '../../types'
      ),
      RULE_CHAT_SLICE_CANNOT_IMPORT_LEGACY_STORE_TYPES
    )
  })

  it('internal 不能依赖 slice', () => {
    expectOnlyRule(
      buildViolationsForEdge(
        'src/renderer/stores/chat/internal/commitMessages.ts',
        'src/renderer/stores/chat/slices/messageSlice.ts',
        '../slices/messageSlice'
      ),
      RULE_CHAT_INTERNAL_CANNOT_IMPORT_SLICES
    )
  })

  it('internal 不能依赖 store facade 或组装入口', () => {
    for (const target of [
      'src/renderer/stores/useChatStore.ts',
      'src/renderer/stores/chat/index.ts',
      'src/renderer/stores/chat/createChatStore.ts'
    ]) {
      expectOnlyRule(
        buildViolationsForEdge(
          'src/renderer/stores/chat/internal/focusedSessionReconcile.ts',
          target,
          '../index'
        ),
        RULE_CHAT_INTERNAL_CANNOT_IMPORT_STORE_ROOT
      )
    }
  })

  it('internal 只能依赖本领域契约、内部设施、shared 与 renderer/lib', () => {
    for (const target of [
      'src/renderer/stores/types.ts',
      'src/renderer/stores/useRunStore.ts',
      'src/renderer/features/chat/partialJsonArgs.ts'
    ]) {
      expectOnlyRule(
        buildViolationsForEdge(
          'src/renderer/stores/chat/internal/focusedSessionReconcile.ts',
          target,
          '../../../features/chat/partialJsonArgs'
        ),
        RULE_CHAT_INTERNAL_CANNOT_IMPORT_RENDERER_IMPLEMENTATION
      )
    }
  })

  it('Renderer 组件只能依赖 chat 公共入口，不能依赖 internal 或 slice', () => {
    for (const component of [
      'src/renderer/App.tsx',
      'src/renderer/components/Sidebar.tsx',
      'src/renderer/features/chat/ChatPanel.tsx'
    ]) {
      for (const target of [
        'src/renderer/stores/chat/internal/commitMessages.ts',
        'src/renderer/stores/chat/slices/messageSlice.ts'
      ]) {
        expectOnlyRule(
          buildViolationsForEdge(component, target, '@renderer/stores/chat/internal/commitMessages'),
          RULE_COMPONENTS_CANNOT_IMPORT_CHAT_INTERNALS
        )
      }
    }
  })

  it('允许 slice/internal 依赖 types 与 internal，允许组件依赖公共入口', () => {
    const allowedEdges = [
      [
        'src/renderer/stores/chat/slices/messageSlice.ts',
        'src/renderer/stores/chat/types.ts'
      ],
      [
        'src/renderer/stores/chat/slices/messageSlice.ts',
        'src/renderer/stores/chat/internal/commitMessages.ts'
      ],
      [
        'src/renderer/stores/chat/slices/streamSlice.ts',
        'src/renderer/lib/partialJsonArgs.ts'
      ],
      [
        'src/renderer/stores/chat/internal/commitMessages.ts',
        'src/renderer/stores/chat/types.ts'
      ],
      [
        'src/renderer/stores/chat/internal/focusedSessionReconcile.ts',
        'src/renderer/lib/focusedSessionRecovery.ts'
      ],
      [
        'src/renderer/features/chat/ChatPanel.tsx',
        'src/renderer/stores/chat/index.ts'
      ]
    ] as const

    for (const [from, to] of allowedEdges) {
      expect(buildViolationsForEdge(from, to, '@renderer/stores/chat')).toEqual([])
    }
  })

  it('当前生产源码没有 renderer chat store 边界违规', () => {
    const repoRoot = findRepoRoot(path.resolve(import.meta.dirname, '../../..'))
    const scan = scanSourceTree(repoRoot)
    const chatViolations = scan.violations.filter((v) => CHAT_SLICE_RULES.includes(v.rule as (typeof CHAT_SLICE_RULES)[number]))
    expect(chatViolations, JSON.stringify(chatViolations, null, 2)).toEqual([])
  })
})
