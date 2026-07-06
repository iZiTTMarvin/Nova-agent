/**
 * PrivacyFilter 单测 — 断言过滤后不含敏感串（测试用假密钥，非真实凭据）
 */
import { describe, it, expect } from 'vitest'
import {
  filterPrivacyText,
  filterToolPayload,
  isSensitiveFilePath,
  PRIVACY_REDACTED
} from '../../../../src/runtime/memory/PrivacyFilter'

/** 测试专用假密钥（格式合法但非真实凭据） */
const FAKE_SK = 'sk-fakefortestonly000000000001'
const FAKE_AWS = 'AKIA0123456789ABCDEF'
const FAKE_BEARER = 'Bearer fakebearerfortestonlytoken123'
const FAKE_GH = 'ghp_fakefortestonly000000000000000000'

describe('isSensitiveFilePath', () => {
  it('识别 .env 与私钥路径', () => {
    expect(isSensitiveFilePath('.env')).toBe(true)
    expect(isSensitiveFilePath('project/.env.local')).toBe(true)
    expect(isSensitiveFilePath('secrets/id_rsa')).toBe(true)
    expect(isSensitiveFilePath('cert.pem')).toBe(true)
    expect(isSensitiveFilePath('src/foo.ts')).toBe(false)
  })
})

describe('filterPrivacyText', () => {
  it('剥离 sk- / AKIA / Bearer / GitHub token', () => {
    const raw = `key=${FAKE_SK} aws=${FAKE_AWS} auth=${FAKE_BEARER} gh=${FAKE_GH}`
    const result = filterPrivacyText(raw)
    expect(result.hadSensitive).toBe(true)
    expect(result.shouldDiscard).toBe(false)
    expect(result.text).not.toContain(FAKE_SK)
    expect(result.text).not.toContain(FAKE_AWS)
    expect(result.text).not.toContain('fakebearerfortestonly')
    expect(result.text).not.toContain(FAKE_GH)
    expect(result.text).toContain(PRIVACY_REDACTED)
  })

  it('剥离 <private> 整段', () => {
    const raw = 'before <private>secret stuff</private> after'
    const result = filterPrivacyText(raw)
    expect(result.hadSensitive).toBe(true)
    expect(result.text).not.toContain('secret stuff')
    expect(result.text).toContain('before')
    expect(result.text).toContain('after')
  })

  it('剥离单行 .env 风格 KEY=VALUE', () => {
    const raw = 'API_KEY=fakevaluefortestonly12345'
    const result = filterPrivacyText(raw)
    expect(result.hadSensitive).toBe(true)
    expect(result.text).not.toContain('fakevaluefortestonly12345')
  })

  it('多行 .env 文件 fail-closed 整条丢弃', () => {
    const raw = 'DB_HOST=localhost\nDB_PASS=fakepassfortest\nAPI_KEY=fakekeyfortest'
    const result = filterPrivacyText(raw)
    expect(result.shouldDiscard).toBe(true)
    expect(result.text).toBe('')
  })

  it('超长输出截断', () => {
    const raw = 'x'.repeat(9000)
    const result = filterPrivacyText(raw, { maxOutputChars: 100 })
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThan(200)
    expect(result.text).toContain('[truncated]')
  })
})

describe('filterToolPayload', () => {
  it('敏感路径整条丢弃', () => {
    const result = filterToolPayload('ok', 'output', ['.env'])
    expect(result.shouldDiscard).toBe(true)
    expect(result.filteredOutput).toBe('')
  })

  it('正常路径过滤后保留安全片段', () => {
    const result = filterToolPayload(
      'edit src/a.ts',
      `line1\nline2\n${FAKE_SK}`,
      ['src/a.ts']
    )
    expect(result.shouldDiscard).toBe(false)
    expect(result.filteredOutput).not.toContain(FAKE_SK)
    expect(result.filteredOutput).toContain('line1')
  })
})
