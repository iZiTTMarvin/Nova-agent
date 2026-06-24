import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  validateModelConfig,
  saveModelConfig,
  loadModelConfig,
  getModelConfigPath,
  loadLlmRegistry,
  saveLlmRegistry
} from '../../../../src/runtime/model/config'
import { migrateV1ToV2 } from '../../../../src/shared/config/llmRegistry'
import type { ModelConfig } from '../../../../src/shared/config'

/** 创建临时目录用于测试配置读写 */
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-config-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── validateModelConfig ──────────────────────────────────────

describe('validateModelConfig', () => {
  it('对合法配置返回 valid: true', () => {
    const result = validateModelConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      modelId: 'gpt-4o'
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.config.baseUrl).toBe('https://api.openai.com/v1')
      expect(result.config.apiKey).toBe('sk-test-key')
      expect(result.config.modelId).toBe('gpt-4o')
    }
  })

  it('对 null 输入返回三个字段的错误', () => {
    const result = validateModelConfig(null)
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(3)
    }
  })

  it('对空对象返回三个字段的错误', () => {
    const result = validateModelConfig({})
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(3)
    }
  })

  it('对空字符串字段返回非空校验错误', () => {
    const result = validateModelConfig({
      baseUrl: '',
      apiKey: '   ',
      modelId: ''
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(3)
    }
  })

  it('对不以 http:// 或 https:// 开头的 baseUrl 返回格式错误', () => {
    const result = validateModelConfig({
      baseUrl: 'ftp://api.example.com/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-4o'
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0].field).toBe('baseUrl')
      expect(result.errors[0].message).toContain('http://')
    }
  })

  it('对以 http:// 开头的合法 baseUrl 通过校验', () => {
    const result = validateModelConfig({
      baseUrl: 'http://localhost:8080/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-4o'
    })
    expect(result.valid).toBe(true)
  })

  it('对以 https:// 开头的合法 baseUrl 通过校验', () => {
    const result = validateModelConfig({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
      modelId: 'gpt-4o'
    })
    expect(result.valid).toBe(true)
  })

  it('会自动 trim 各字段值的空白', () => {
    const result = validateModelConfig({
      baseUrl: '  https://api.openai.com/v1  ',
      apiKey: '  sk-test  ',
      modelId: '  gpt-4o  '
    })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.config.baseUrl).toBe('https://api.openai.com/v1')
      expect(result.config.apiKey).toBe('sk-test')
      expect(result.config.modelId).toBe('gpt-4o')
    }
  })

  it('对多字段同时错误返回多个错误', () => {
    const result = validateModelConfig({
      baseUrl: 'not-a-url',
      apiKey: '',
      modelId: ''
    })
    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.errors).toHaveLength(3)
    }
  })
})

// ── saveModelConfig ─────────────────────────────────────────

describe('saveModelConfig', () => {
  const validConfig: ModelConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    modelId: 'gpt-4o'
  }

  it('保存配置后可以完整加载回来', () => {
    saveModelConfig(validConfig, tmpDir)
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).not.toBeNull()
    expect(loaded).toEqual(validConfig)
  })

  it('返回值是 trim 后的合法配置', () => {
    const configWithSpaces: ModelConfig = {
      baseUrl: '  https://api.openai.com/v1  ',
      apiKey: '  sk-test  ',
      modelId: '  gpt-4o  '
    }
    const result = saveModelConfig(configWithSpaces, tmpDir)
    expect(result.baseUrl).toBe('https://api.openai.com/v1')
    expect(result.apiKey).toBe('sk-test')
    expect(result.modelId).toBe('gpt-4o')
  })

  it('自动创建不存在的 settings 目录', () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested')
    saveModelConfig(validConfig, nestedDir)
    const settingsDir = path.join(nestedDir, 'settings')
    expect(fs.existsSync(settingsDir)).toBe(true)
  })

  it('多次保存会覆盖之前的配置', () => {
    saveModelConfig(validConfig, tmpDir)

    const updatedConfig: ModelConfig = {
      baseUrl: 'https://custom.api.com/v1',
      apiKey: 'sk-updated-key',
      modelId: 'claude-3-5-sonnet'
    }
    saveModelConfig(updatedConfig, tmpDir)

    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toEqual(updatedConfig)
  })

  it('配置文件带缩进格式化（可读性）', () => {
    saveModelConfig(validConfig, tmpDir)
    const configPath = getModelConfigPath(tmpDir)
    const content = fs.readFileSync(configPath, 'utf8')
    // JSON.stringify(config, null, 2) 应该包含缩进换行
    expect(content).toContain('\n')
  })

  it('校验失败时抛出包含字段错误信息的异常', () => {
    const badConfig = { baseUrl: '', apiKey: '', modelId: '' } as unknown as ModelConfig
    expect(() => saveModelConfig(badConfig, tmpDir)).toThrow()
    try {
      saveModelConfig(badConfig, tmpDir)
    } catch (err) {
      const message = (err as Error).message
      expect(message).toContain('配置校验失败')
    }
  })

  it('校验失败时不写入文件', () => {
    const badConfig = { baseUrl: 'bad-url', apiKey: '', modelId: '' } as unknown as ModelConfig
    expect(() => saveModelConfig(badConfig, tmpDir)).toThrow()
    // 不应该有文件残留
    expect(fs.existsSync(getModelConfigPath(tmpDir))).toBe(false)
  })
})

// ── loadModelConfig ─────────────────────────────────────────

describe('loadModelConfig', () => {
  const validConfig: ModelConfig = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test-key',
    modelId: 'gpt-4o'
  }

  it('配置不存在时返回 null', () => {
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('保存后可以完整加载回来', () => {
    saveModelConfig(validConfig, tmpDir)
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toEqual(validConfig)
  })

  it('损坏的配置文件返回 null（容错）', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(configPath, '{ invalid json }}}', 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('缺少 baseUrl 和 modelId 的配置文件返回 null', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(configPath, JSON.stringify({ apiKey: 'sk-test' }), 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('缺少 apiKey 的配置文件返回 null（关键：防止坏配置进入启动链路）', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    // 有 baseUrl 和 modelId 但缺少 apiKey
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: 'https://api.openai.com/v1',
      modelId: 'gpt-4o'
    }), 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('apiKey 为空字符串的配置文件返回 null', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      modelId: 'gpt-4o'
    }), 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('baseUrl 不以 http/https 开头的配置文件返回 null', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: 'ftp://bad-url.com',
      apiKey: 'sk-test',
      modelId: 'gpt-4o'
    }), 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).toBeNull()
  })

  it('加载合法配置时自动 trim 字段空白', () => {
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
    }
    // 手动写入包含空白的有效配置
    fs.writeFileSync(configPath, JSON.stringify({
      baseUrl: '  https://api.openai.com/v1  ',
      apiKey: '  sk-test  ',
      modelId: '  gpt-4o  '
    }), 'utf8')
    const loaded = loadModelConfig(tmpDir)
    expect(loaded).not.toBeNull()
    expect(loaded!.baseUrl).toBe('https://api.openai.com/v1')
    expect(loaded!.apiKey).toBe('sk-test')
    expect(loaded!.modelId).toBe('gpt-4o')
  })
})

// ── getModelConfigPath ────────────────────────────────────────

describe('getModelConfigPath', () => {
  it('返回正确拼接的路径', () => {
    const result = getModelConfigPath('/app/data')
    expect(result).toBe(path.join('/app/data', 'settings', 'model.json'))
  })
})

// ── v2 LlmRegistry ───────────────────────────────────────────

describe('loadLlmRegistry / saveLlmRegistry', () => {
  it('v1 配置文件自动迁移为 v2', () => {
    const v1 = {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-key',
      modelId: 'gpt-4o'
    }
    const configPath = getModelConfigPath(tmpDir)
    const configDir = path.dirname(configPath)
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(v1), 'utf8')

    const registry = loadLlmRegistry(tmpDir)
    expect(registry).not.toBeNull()
    expect(registry!.version).toBe(2)
    expect(registry!.providers.length).toBeGreaterThanOrEqual(1)

    const active = loadModelConfig(tmpDir)
    expect(active?.modelId).toBe('gpt-4o')
  })

  it('saveLlmRegistry 写入 v2 并可读回', () => {
    const registry = migrateV1ToV2({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
      modelId: 'deepseek-chat'
    })
    saveLlmRegistry(tmpDir, registry)
    const loaded = loadLlmRegistry(tmpDir)
    expect(loaded?.version).toBe(2)
    expect(loaded?.providers[0].modelId).toBeUndefined()
    expect(loaded?.providers[0].models[0].modelId).toBe('deepseek-chat')
  })
})
