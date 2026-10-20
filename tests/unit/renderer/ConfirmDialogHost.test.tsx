// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmDialogHost } from '../../../src/renderer/features/confirm/ConfirmDialogHost'
import { confirmDialog } from '../../../src/renderer/features/confirm/confirmDialog'
import { act, renderDom } from './renderDom'

function buttonLabels(): string[] {
  return Array.from(document.body.querySelectorAll('.confirm-dialog__actions button'))
    .map(button => button.textContent?.trim() ?? '')
}

function clickButton(label: string): void {
  const button = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.confirm-dialog__actions button'))
    .find(item => item.textContent?.trim() === label)
  if (!button) throw new Error(`button not found: ${label}`)
  act(() => button.click())
}

describe('ConfirmDialogHost', () => {
  beforeEach(() => {
    window.scrollTo = vi.fn()
    Object.defineProperty(window, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value }
    })
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    })
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.removeAttribute('open')
    })
  })

  it('返回被点按钮的下标，并按先后顺序依次展示排队的请求', async () => {
    const renderer = renderDom(<ConfirmDialogHost />)
    let first!: Promise<number>
    let second!: Promise<number>
    act(() => {
      first = confirmDialog({ title: '删除会话', message: '确定吗？', buttons: ['取消', '删除'], defaultId: 0 })
      second = confirmDialog({ type: 'error', message: '失败了', buttons: ['确定'] })
    })

    expect(buttonLabels()).toEqual(['取消', '删除'])
    clickButton('删除')
    await expect(first).resolves.toBe(1)

    expect(buttonLabels()).toEqual(['确定'])
    clickButton('确定')
    await expect(second).resolves.toBe(0)

    expect(document.body.querySelector('.confirm-dialog')).toBeNull()
    renderer.unmount()
  })

  it('Esc 关闭时返回 cancelId，不会被当作确认', async () => {
    const renderer = renderDom(<ConfirmDialogHost />)
    let pending!: Promise<number>
    act(() => {
      pending = confirmDialog({ message: '放弃修改？', buttons: ['放弃', '继续编辑'], cancelId: 1 })
    })

    const dialog = document.body.querySelector<HTMLDialogElement>('dialog.confirm-dialog')
    expect(dialog).not.toBeNull()
    act(() => {
      dialog!.dispatchEvent(new Event('cancel', { cancelable: true }))
    })

    await expect(pending).resolves.toBe(1)
    renderer.unmount()
  })
})
