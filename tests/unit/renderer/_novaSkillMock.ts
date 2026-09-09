/**
 * 测试环境 window.nova.skill mock
 */
import { vi } from 'vitest'
import type { NovaSkillApi } from '../../../src/shared/skills/types'

export function createNovaSkillMock(): NovaSkillApi {
  return {
    list: vi.fn(() =>
      Promise.resolve({
        skills: [],
        loading: false,
        error: null,
        refreshedAt: null,
        diagnostics: [],
        modelBudget: { cap: 30, eligible: 0 }
      })
    ),
    get: vi.fn(() => Promise.resolve(null)),
    getBody: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(),
    delete: vi.fn(),
    toggle: vi.fn(),
    import: vi.fn(),
    export: vi.fn(() => Promise.resolve({ canceled: true })),
    reload: vi.fn(() => Promise.resolve({ count: 0, errors: [] })),
    pickImportFile: vi.fn(() => Promise.resolve(null)),
    onChange: vi.fn(() => () => {})
  }
}
