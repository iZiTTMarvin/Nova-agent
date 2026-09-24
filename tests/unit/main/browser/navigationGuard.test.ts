import { describe, expect, it } from 'vitest'
import {
  isEquivalentNavigationUrl,
  isNavigationAborted
} from '../../../../src/main/browser/navigationGuard'

describe('导航中断复核', () => {
  it('只把 ERR_ABORTED 当成可复核的中断', () => {
    expect(isNavigationAborted(Object.assign(new Error('ERR_ABORTED (-3) loading'), { errno: -3 }))).toBe(true)
    expect(isNavigationAborted(Object.assign(new Error('fail'), { code: 'ERR_ABORTED' }))).toBe(true)
    expect(isNavigationAborted(new Error('ERR_NAME_NOT_RESOLVED'))).toBe(false)
    expect(isNavigationAborted('ERR_ABORTED')).toBe(false)
  })

  it('www 与尾斜杠视为同一目标，换主机不是', () => {
    expect(isEquivalentNavigationUrl(
      'https://www.example.com/app/',
      'https://example.com/app'
    )).toBe(true)
    expect(isEquivalentNavigationUrl(
      'https://example.com/app',
      'https://example.com/other'
    )).toBe(false)
  })
})
