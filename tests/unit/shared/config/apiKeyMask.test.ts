import { describe, it, expect } from 'vitest'
import { maskApiKey, isMaskedApiKey } from '../../../../src/shared/config/apiKeyMask'

describe('apiKeyMask', () => {
  it('掩码保留首尾各 3 字符', () => {
    expect(maskApiKey('sk-abcdefgh123')).toBe('sk-***123')
  })

  it('识别掩码占位', () => {
    expect(isMaskedApiKey('sk-***abc')).toBe(true)
    expect(isMaskedApiKey('sk-realkey')).toBe(false)
  })
})
