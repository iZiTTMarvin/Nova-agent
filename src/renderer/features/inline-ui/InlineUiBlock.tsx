/**
 * openui 内联块：解析 → 求值 → 渲染，并持有交互变量状态。
 *
 * 变量状态的唯一写入方是 inlineUiState 模块；interactive 为 false（活动尾部）时
 * 始终用初始值渲染、控件全部禁用，不涉及任何读写——流式期间的重渲染因此不碰用户状态。
 * 由流式切到可交互时原地换用已保存的变量，不重挂、不重播入场动画。
 */
import React, { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useVisualizationMessageSubmitter } from '../visualization/VisualizationMessageContext'
import { formatVisualizationEventMessage } from '../visualization/visualizationMessages'
import {
  adoptInlineUiVars,
  initialInlineUiVars,
  parseInlineUi,
  renderInlineUi,
  runInlineUiActions,
  type InlineUiNode,
  type InlineUiPrimitive,
  type InlineUiVars
} from './inlineUiLanguage'
import { clearInlineUiState, inlineUiStateKey, readInlineUiState, writeInlineUiState } from './inlineUiState'
import { recordInterfaceState } from '../../lib/interfaceStateOutbox'
import { summarizeInlineUiChanges } from './inlineUiChangeSummary'
import { InlineUiTree, type InlineUiHandlers } from './InlineUiComponents'
import type { InlineUiScopeValue } from './InlineUiScope'
import './InlineUiBlock.css'

export interface InlineUiBlockProps {
  scope: InlineUiScopeValue
  code: string
  interactive: boolean
  fallback: ReactNode
}

const ASK_NOTICE_MS = 2400
const ASK_MIN_INTERVAL_MS = 1000
const EMPTY_VARS: InlineUiVars = Object.freeze({})

/**
 * 入场动画只播一次：流式尾部出现过的文本块、已经完整挂载过的组件，
 * 之后的重挂（封口、回合结束、滚动回来）都直接显示终态。
 */
const streamedBlocks = new Set<string>()
const settledWidgets = new Set<string>()
const MAX_TRACKED = 500

function remember(set: Set<string>, key: string): void {
  set.add(key)
  if (set.size > MAX_TRACKED) {
    const oldest = set.values().next().value
    if (oldest !== undefined) set.delete(oldest)
  }
}

/** 求值异常也落在错误边界内：代码继续流入时自动重试，仍失败就按代码块显示 */
export const InlineUiBlock: React.FC<InlineUiBlockProps> = props => (
  <ErrorBoundary fallback={props.fallback} resetKey={props.code}>
    <InlineUiBlockInner {...props} />
  </ErrorBoundary>
)

const InlineUiBlockInner: React.FC<InlineUiBlockProps> = ({ scope, code, interactive, fallback }) => {
  const program = useMemo(() => parseInlineUi(code), [code])
  const stateKey = inlineUiStateKey(scope.blockKey, code)
  const [local, setLocal] = useState<{ key: string; vars: InlineUiVars } | null>(null)
  const [animate] = useState(() => {
    if (!interactive) return true
    return !streamedBlocks.has(scope.blockKey) && !settledWidgets.has(stateKey)
  })
  const [notice, setNotice] = useState<string | null>(null)
  const lastAskAtRef = useRef(0)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submitter = useVisualizationMessageSubmitter()

  const vars = useMemo<InlineUiVars>(() => {
    if (!program) return EMPTY_VARS
    if (!interactive) return initialInlineUiVars(program)
    if (local?.key === stateKey) return local.vars
    return adoptInlineUiVars(program, readInlineUiState(stateKey))
  }, [program, interactive, stateKey, local])

  const tree = useMemo(() => (program ? renderInlineUi(program, vars) : null), [program, vars])

  useEffect(() => {
    if (!interactive) remember(streamedBlocks, scope.blockKey)
    else if (tree) remember(settledWidgets, stateKey)
  }, [interactive, scope.blockKey, stateKey, tree])

  useEffect(() => () => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
  }, [])

  // 流式中 root 还没写出来时给占位，不把半截代码闪给用户；完成后仍无效才按代码块显示
  if (!program || !tree) {
    return interactive ? <>{fallback}</> : (
      <div className="inline-ui inline-ui--pending" role="status" aria-live="polite">
        <span className="inline-ui__pending-bar" aria-hidden="true" />
        <span className="inline-ui__pending-text">正在生成交互组件…</span>
      </div>
    )
  }

  const commit = (next: InlineUiVars): void => {
    setLocal({ key: stateKey, vars: next })
    const initial = initialInlineUiVars(program)
    const pristine = Object.keys(initial).every(name => initial[name] === next[name])
    if (pristine) clearInlineUiState(stateKey)
    else writeInlineUiState(stateKey, { ...next })
    recordInterfaceState(scope.sessionId, stateKey, summarizeInlineUiChanges(program, renderInlineUi(program, next), next))
  }

  const showNotice = (text: string): void => {
    setNotice(text)
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null
      setNotice(null)
    }, ASK_NOTICE_MS)
  }

  const handlers: InlineUiHandlers = {
    interactive,
    onSetVar: (variable: string, value: InlineUiPrimitive) => {
      if (!interactive || vars[variable] === value) return
      commit({ ...vars, [variable]: value })
    },
    onButton: (button: Extract<InlineUiNode, { type: 'button' }>) => {
      if (!interactive || button.actions.length === 0) return
      const outcome = runInlineUiActions(button.actions, program, vars)
      if (!outcome) return
      if (outcome.vars !== vars) commit(outcome.vars)
      if (!outcome.ask) return
      // 同一块两次追问至少间隔 1 秒；blocked 只显示提示，不碰草稿
      const now = Date.now()
      if (now - lastAskAtRef.current < ASK_MIN_INTERVAL_MS) return
      lastAskAtRef.current = now
      const { label, prompt } = outcome.ask
      void submitter(formatVisualizationEventMessage(label, 'explore', { prompt }), 'event').then(result => {
        if (result.status === 'blocked') showNotice(result.notice)
      })
    }
  }

  return (
    <div className={`inline-ui${animate ? ' inline-ui--animate' : ''}`} data-interactive={interactive ? 'true' : 'false'}>
      {notice !== null && (
        <div className="inline-ui__notice" role="status">
          {notice}
        </div>
      )}
      <InlineUiTree node={tree} handlers={handlers} />
    </div>
  )
}
