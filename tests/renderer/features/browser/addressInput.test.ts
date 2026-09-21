import { describe, expect, it } from 'vitest'
import { composeBrowserNavigationUrl, shouldCommitAddressKey } from '../../../../src/renderer/features/browser/addressInput'

describe('地址栏提交', () => {
  it('补全缺 scheme 的公网地址，本机走 http', () => {
    expect(composeBrowserNavigationUrl('example.com/a')).toBe('https://example.com/a')
    expect(composeBrowserNavigationUrl('localhost:5173')).toBe('http://localhost:5173')
    expect(composeBrowserNavigationUrl('127.0.0.1:3000/app')).toBe('http://127.0.0.1:3000/app')
    expect(composeBrowserNavigationUrl('https://ok.test')).toBe('https://ok.test')
  })

  it('拒绝危险或空输入', () => {
    expect(composeBrowserNavigationUrl('')).toBeNull()
    expect(composeBrowserNavigationUrl('javascript:alert(1)')).toBeNull()
    expect(composeBrowserNavigationUrl('file:///tmp/x')).toBeNull()
  })

  it('IME 合成期间的 Enter 不提交', () => {
    expect(shouldCommitAddressKey({ key: 'Enter', isComposing: true })).toBe(false)
    expect(shouldCommitAddressKey({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(false)
    expect(shouldCommitAddressKey({ key: 'Enter' })).toBe(true)
    expect(shouldCommitAddressKey({ key: 'a' })).toBe(false)
  })
})
