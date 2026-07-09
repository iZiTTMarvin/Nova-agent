/**
 * AskQuestionToolCard 解析与文案
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import {
  AskQuestionToolCard,
  parseAskQuestionResult
} from '../../../src/renderer/features/chat/AskQuestionToolCard'

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

describe('AskQuestionToolCard', () => {
  it('running 显示正在询问', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <AskQuestionToolCard
          args={{ questions: [{ question: 'Q' }] }}
          status="running"
        />
      )
    })
    expect(JSON.stringify(renderer?.toJSON())).toContain('正在询问')
    act(() => {
      renderer?.unmount()
    })
  })

  it('success 显示已询问 N 个问题', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <AskQuestionToolCard
          args={{
            questions: [
              { question: 'Q1' },
              { question: 'Q2' }
            ]
          }}
          status="success"
          result='User has answered your questions: "Q1"="A"; "Q2"="B".'
        />
      )
    })
    expect(JSON.stringify(renderer?.toJSON())).toContain('已询问 2 个问题')
    act(() => {
      renderer?.unmount()
    })
  })
})
