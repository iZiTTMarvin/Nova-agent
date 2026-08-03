// @vitest-environment jsdom

/**
 * AskQuestionToolCard 解析与文案
 */
import React from 'react'
import { describe, expect, it } from 'vitest'
import {
  AskQuestionToolCard,
  parseAskQuestionResult
} from '../../../src/renderer/features/chat/AskQuestionToolCard'
import { renderDom } from './renderDom'

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
    const renderer = renderDom(
      <AskQuestionToolCard
        args={{ questions: [{ question: 'Q' }] }}
        status="running"
      />
    )
    expect(renderer.container.textContent ?? '').toContain('正在询问')
    renderer.unmount()
  })

  it('success 显示已询问 N 个问题', () => {
    const renderer = renderDom(
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
    expect(renderer.container.textContent ?? '').toContain('已询问 2 个问题')
    renderer.unmount()
  })
})
