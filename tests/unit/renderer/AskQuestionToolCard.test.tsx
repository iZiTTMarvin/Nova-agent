import { describe, expect, it } from 'vitest'
import { parseAskQuestionResult } from '../../../src/renderer/features/chat/AskQuestionToolCard'

describe('parseAskQuestionResult', () => {
  it('解析正常问答', () => {
    const out = parseAskQuestionResult(
      'User has answered your questions: "方向"="接入方案"; "偏好"="深色".'
    )
    expect(out.dismissed).toBe(false)
    expect(out.pairs).toEqual([
      { question: '方向', answer: '接入方案' },
      { question: '偏好', answer: '深色' }
    ])
  })

  it('解析 dismissed 与 custom', () => {
    expect(parseAskQuestionResult('User dismissed the question.').dismissed).toBe(true)
    const out = parseAskQuestionResult(
      'User has answered your questions: "Q1"=[dismissed]; "Q2"="A", custom="其它".'
    )
    expect(out.pairs).toEqual([
      { question: 'Q1', answer: '[已跳过]' },
      { question: 'Q2', answer: 'A（自定义：其它）' }
    ])
  })
})
