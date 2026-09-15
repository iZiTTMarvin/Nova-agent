/**
 * 诊断素材脱敏：密钥模式必须被机械屏蔽，这是诊断包的硬红线。
 */
import { describe, it, expect } from 'vitest'
import { redactSecrets } from '../../../../src/main/diagnostics/redact'

describe('redactSecrets', () => {
  it('屏蔽 sk- 风格 API Key，保留周边文案', () => {
    const line = 'provider auth failed with key sk-abc123defGHI456jkl789'
    const out = redactSecrets(line)
    expect(out).not.toContain('sk-abc123defGHI456jkl789')
    expect(out).toContain('provider auth failed with key')
  })

  it('屏蔽 Bearer 与 Authorization 头', () => {
    const out = redactSecrets('headers: { Authorization: Bearer eyJhbGciOi.eyJzdWIi.signedpart }')
    expect(out).not.toContain('eyJhbGciOi')
    expect(out).toContain('Authorization')
    expect(out).toContain('Bearer')
  })

  it('屏蔽 JSON 字段形态的 apiKey / token，保留字段名与引号结构', () => {
    const out = redactSecrets('{"apiKey":"sk-abcdefgh12345678","token":"ghp_16C7e42F292c6917dErgithub"}')
    expect(out).not.toContain('sk-abcdefgh12345678')
    expect(out).not.toContain('ghp_16C7e42F292c6917dErgithub')
    expect(out).toContain('"apiKey"')
    expect(out).toContain('"token"')
  })

  it('不含凭据的普通日志行原样保留', () => {
    const line = '[2026-09-14 21:00:00.123] info [AgentLoop] message completed id=msg_abc'
    expect(redactSecrets(line)).toBe(line)
  })

  it('模拟真实日志行混合密钥场景：任何密钥模式都不外泄', () => {
    const logLines = [
      'config saved provider=minimax baseUrl=https://api.minimax.chat/v1 apiKey=sk-MINIMAXkey0123456789',
      'request failed status=401 body={"error":{"message":"Incorrect API key provided: sk-proj-AAAA1111BBBB2222"}}',
      'auth header Authorization="Bearer tok_live_9f8e7d6c5b4a"',
      'normal line without secrets'
    ].join('\n')
    const out = redactSecrets(logLines)
    expect(out).not.toMatch(/sk-[A-Za-z0-9][A-Za-z0-9_-]{7,}/)
    expect(out).not.toContain('tok_live_9f8e7d6c5b4a')
    expect(out).toContain('normal line without secrets')
    expect(out).toContain('baseUrl=https://api.minimax.chat/v1')
  })
})
