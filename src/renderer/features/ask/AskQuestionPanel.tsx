import React, { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '../../stores/useAgentStore'
import type { AskQuestionAnswer } from '../../../shared/askQuestion/types'
import './AskQuestionPanel.css'

/**
 * AskQuestionPanel —— 向用户提问面板（Dock 形态）
 *
 * 职责：
 * - 从 useAgentStore.pendingAskQuestion 读取请求；为 null 时不渲染任何东西
 * - 多问题向导：单步展示一题，逐题推进，最后一步提交全部答案
 * - 单选 / 多选切换：current.multiple 时 checkbox 多选；否则 radio 单选
 * - 推荐项渲染 "(Recommended)" 标记
 * - custom !== false 时显示自定义输入框；custom === false 时不显示
 * - "跳过全部" → dismissAskQuestion（IPC 传空数组，工具输出 dismissed）
 * - 单题且非多选时，选中选项后自动提交（带 120ms debounce）
 *
 * 局部状态：currentStep / answers / customInputs。提交 / dismiss 后均重置，
 * 避免下一轮提问残留上一轮选择。
 */
export const AskQuestionPanel: React.FC = () => {
  const pending = useAgentStore(state => state.pendingAskQuestion)
  const respondAskQuestion = useAgentStore(state => state.respondAskQuestion)
  const dismissAskQuestion = useAgentStore(state => state.dismissAskQuestion)

  const [currentStep, setCurrentStep] = useState(0)
  const [answers, setAnswers] = useState<Map<number, AskQuestionAnswer>>(new Map())
  const [customInputs, setCustomInputs] = useState<Map<number, string>>(new Map())
  const [showCustom, setShowCustom] = useState(false)
  const autoSubmitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // pending 变化时（新一轮提问或刚提交清空），重置局部状态
  useEffect(() => {
    setCurrentStep(0)
    setAnswers(new Map())
    setCustomInputs(new Map())
    setShowCustom(false)
  }, [pending?.requestId])

  // 卸载时清理自动提交定时器，避免 pending 清空后仍触发 respond
  useEffect(() => {
    return () => {
      if (autoSubmitTimerRef.current) {
        clearTimeout(autoSubmitTimerRef.current)
        autoSubmitTimerRef.current = null
      }
    }
  }, [])

  if (!pending) return null

  const questions = pending.questions
  const current = questions[currentStep]

  /** 读取某题当前已记录的答案；未访问过的题默认 { selectedLabels: [] } */
  const getAnswer = (index: number): AskQuestionAnswer =>
    answers.get(index) ?? { selectedLabels: [] }

  /** 更新某题答案，复用 Map 并 set 新条目 */
  const updateAnswer = (index: number, answer: AskQuestionAnswer): void => {
    const next = new Map(answers)
    next.set(index, answer)
    setAnswers(next)
  }

  /** 单题且非多选场景下，选中后自动提交 */
  const scheduleAutoSubmit = (): void => {
    if (questions.length !== 1 || current.multiple) return
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current)
    }
    autoSubmitTimerRef.current = setTimeout(() => {
      autoSubmitTimerRef.current = null
      void handleSubmit()
    }, 120)
  }

  /** 选项点击：单选覆盖、多选切换包含/排除 */
  const toggleOption = (label: string): void => {
    const ans = getAnswer(currentStep)
    if (current.multiple) {
      const selected = ans.selectedLabels
      const nextSelected = selected.includes(label)
        ? selected.filter(l => l !== label)
        : [...selected, label]
      updateAnswer(currentStep, { ...ans, selectedLabels: nextSelected })
    } else {
      updateAnswer(currentStep, { ...ans, selectedLabels: [label] })
      scheduleAutoSubmit()
    }
  }

  /** 自定义输入：同步写入 customInputs 与 answers.customInput（空串时清 undefined） */
  const handleCustomInput = (value: string): void => {
    const nextCustom = new Map(customInputs)
    nextCustom.set(currentStep, value)
    setCustomInputs(nextCustom)
    const ans = getAnswer(currentStep)
    updateAnswer(currentStep, { ...ans, customInput: value || undefined })
  }

  const isOptionSelected = (label: string): boolean =>
    getAnswer(currentStep).selectedLabels.includes(label)

  /** 提交：未访问过的题默认 { selectedLabels: [] }，按顺序组装 answers 数组 */
  const handleSubmit = async (): Promise<void> => {
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current)
      autoSubmitTimerRef.current = null
    }
    const allAnswers: AskQuestionAnswer[] = questions.map((_, i) =>
      answers.get(i) ?? { selectedLabels: [] }
    )
    await respondAskQuestion(allAnswers)
  }

  const handleDismiss = async (): Promise<void> => {
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current)
      autoSubmitTimerRef.current = null
    }
    await dismissAskQuestion()
  }

  const goNext = (): void => {
    if (currentStep < questions.length - 1) setCurrentStep(currentStep + 1)
  }
  const goPrev = (): void => {
    if (currentStep > 0) setCurrentStep(currentStep - 1)
  }

  /** 当前题是否可提交：至少选了一个选项，或在 custom 模式下填了非空文本 */
  const canSubmit = (): boolean => {
    const ans = getAnswer(currentStep)
    if (ans.selectedLabels.length > 0) return true
    if (current.custom !== false && showCustom) {
      const trimmed = customInputs.get(currentStep)?.trim() ?? ''
      return trimmed.length > 0
    }
    return false
  }

  const isSingleQuestion = questions.length === 1
  const progressText = isSingleQuestion ? '' : `${currentStep + 1} / ${questions.length}`
  const headerText = current.header

  return (
    <div className="ask-question-panel">
      <div className="ask-question-header">
        {headerText ? (
          <span className="ask-question-title">{headerText}</span>
        ) : (
          <span className="ask-question-title">请回答以下问题</span>
        )}
        {progressText && <span className="ask-question-progress">{progressText}</span>}
      </div>

      <div className="ask-question-body">
        <p className="ask-question-text">{current.question}</p>

        <div className="ask-question-options">
          {current.options.map((option) => (
            <label
              key={option.label}
              className={`ask-question-option ${isOptionSelected(option.label) ? 'selected' : ''}`}
            >
              <input
                type={current.multiple ? 'checkbox' : 'radio'}
                name={`ask-question-${currentStep}`}
                checked={isOptionSelected(option.label)}
                onChange={() => toggleOption(option.label)}
              />
              <span className="ask-question-option-content">
                <span className="ask-question-option-label">
                  {option.label}
                  {option.recommended && <span className="ask-question-recommended-tag">(Recommended)</span>}
                </span>
                {option.description && <span className="ask-question-option-desc">{option.description}</span>}
              </span>
            </label>
          ))}

          {current.custom !== false && (
            <div className="ask-question-custom-row">
              {showCustom ? (
                <input
                  type="text"
                  autoFocus
                  placeholder="输入你的回答…"
                  value={customInputs.get(currentStep) ?? ''}
                  onChange={(e) => handleCustomInput(e.target.value)}
                  className="ask-question-custom-input"
                />
              ) : (
                <button
                  type="button"
                  className="ask-question-custom-trigger"
                  onClick={() => setShowCustom(true)}
                >
                  输入你的回答…
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="ask-question-footer">
        <div className="ask-question-nav">
          {currentStep > 0 && (
            <button type="button" onClick={goPrev} className="ask-question-btn-secondary">
              上一题
            </button>
          )}
          {currentStep < questions.length - 1 ? (
            <button type="button" onClick={goNext} className="ask-question-btn-primary">
              下一题
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit()}
              className="ask-question-btn-primary"
            >
              提交答案
            </button>
          )}
        </div>
        <button type="button" onClick={handleDismiss} className="ask-question-btn-dismiss">
          跳过全部
        </button>
      </div>
    </div>
  )
}
