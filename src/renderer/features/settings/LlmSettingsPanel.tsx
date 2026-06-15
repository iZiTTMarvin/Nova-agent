/**
 * LLM 模型连接配置面板（自原 SettingsModal 迁入）
 */
import React, { useState, useEffect } from 'react'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { inferVisionSupport } from '../../../shared/config/types'

interface FieldErrors {
  baseUrl?: string
  apiKey?: string
  modelId?: string
  contextWindow?: string
}

export const LlmSettingsPanel: React.FC = () => {
  const modelConfig = useSettingsStore(state => state.modelConfig)
  const saveModelConfig = useSettingsStore(state => state.saveModelConfig)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [contextWindow, setContextWindow] = useState<number | ''>('')
  const [supportsVision, setSupportsVision] = useState<boolean | null>(null)
  const [showKey, setShowKey] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // PRD §5.4：备用模型链（fallback）
  const [fallbacks, setFallbacks] = useState<Array<{ baseUrl: string; apiKey: string; modelId: string }>>([])

  useEffect(() => {
    setBaseUrl(modelConfig?.baseUrl || 'https://api.openai.com/v1')
    setApiKey(modelConfig?.apiKey || '')
    setModelId(modelConfig?.modelId || 'gpt-4o')
    setContextWindow(modelConfig?.contextWindow ?? '')
    setSupportsVision(modelConfig?.supportsVision ?? null)
    setFieldErrors({})
    setSubmitError(null)
    setShowKey(false)
    setFallbacks(
      (modelConfig?.fallbacks ?? []).map(fb => ({
        baseUrl: fb.baseUrl,
        apiKey: fb.apiKey,
        modelId: fb.modelId
      }))
    )
  }, [modelConfig])

  const inferredVision = inferVisionSupport(modelId.trim())

  const validate = (): boolean => {
    const errors: FieldErrors = {}
    const trimmedBaseUrl = baseUrl.trim()
    const trimmedApiKey = apiKey.trim()
    const trimmedModelId = modelId.trim()

    if (!trimmedBaseUrl) {
      errors.baseUrl = '接口地址不能为空'
    } else if (!/^https?:\/\/.+/.test(trimmedBaseUrl)) {
      errors.baseUrl = '接口地址必须以 http:// 或 https:// 开头'
    }
    if (!trimmedApiKey) errors.apiKey = 'API Key 不能为空'
    if (!trimmedModelId) errors.modelId = '模型标识不能为空'
    if (
      contextWindow !== '' &&
      (typeof contextWindow !== 'number' || contextWindow <= 0 || !Number.isInteger(contextWindow))
    ) {
      errors.contextWindow = '上下文窗口必须是正整数'
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setSaving(true)
    setSubmitError(null)
    try {
      // PRD §5.4：只保留三要素齐全的 fallback，过滤空条目
      const validFallbacks = fallbacks
        .map(fb => ({ baseUrl: fb.baseUrl.trim(), apiKey: fb.apiKey.trim(), modelId: fb.modelId.trim() }))
        .filter(fb => fb.baseUrl && fb.apiKey && fb.modelId)

      await saveModelConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelId: modelId.trim(),
        contextWindow: contextWindow === '' ? undefined : contextWindow,
        supportsVision: supportsVision ?? undefined,
        ...(validFallbacks.length > 0 ? { fallbacks: validFallbacks } : {})
      })
      setConfigModalOpen(false)
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : '保存配置失败，请检查参数')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h3 className="settings-panel__title">LLM 配置</h3>
        <p className="settings-panel__desc">配置 OpenAI 兼容接口的地址、凭证与模型参数。</p>
      </header>

      <form className="settings-modal__form settings-panel__scroll" onSubmit={handleSave}>
        <div className="settings-modal__field">
          <label className="settings-modal__label">接口地址 (Base URL)</label>
          <input
            type="text"
            className={`settings-modal__input${fieldErrors.baseUrl ? ' settings-modal__input--error' : ''}`}
            value={baseUrl}
            onChange={e => {
              setBaseUrl(e.target.value)
              setFieldErrors(prev => ({ ...prev, baseUrl: undefined }))
            }}
            placeholder="例如 https://api.openai.com/v1"
          />
          {fieldErrors.baseUrl ? (
            <span className="settings-modal__field-error">{fieldErrors.baseUrl}</span>
          ) : (
            <span className="settings-modal__help">OpenAI 兼容接口的 API 根地址，通常含版本号如 /v1。</span>
          )}
        </div>

        <div className="settings-modal__field">
          <label className="settings-modal__label">API 凭证 (API Key)</label>
          <div className="settings-modal__input-wrapper">
            <input
              type={showKey ? 'text' : 'password'}
              className={`settings-modal__input settings-modal__input--password${fieldErrors.apiKey ? ' settings-modal__input--error' : ''}`}
              value={apiKey}
              onChange={e => {
                setApiKey(e.target.value)
                setFieldErrors(prev => ({ ...prev, apiKey: undefined }))
              }}
              placeholder="sk-..."
            />
            <button type="button" className="settings-modal__toggle-pwd" onClick={() => setShowKey(!showKey)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          {fieldErrors.apiKey ? (
            <span className="settings-modal__field-error">{fieldErrors.apiKey}</span>
          ) : (
            <span className="settings-modal__help">用于身份校验的 API Key。</span>
          )}
        </div>

        <div className="settings-modal__field">
          <label className="settings-modal__label">模型标识 (Model ID)</label>
          <input
            type="text"
            className={`settings-modal__input${fieldErrors.modelId ? ' settings-modal__input--error' : ''}`}
            value={modelId}
            onChange={e => {
              setModelId(e.target.value)
              setFieldErrors(prev => ({ ...prev, modelId: undefined }))
            }}
            placeholder="例如 gpt-4o 或 claude-3-5-sonnet"
          />
          {fieldErrors.modelId ? (
            <span className="settings-modal__field-error">{fieldErrors.modelId}</span>
          ) : (
            <span className="settings-modal__help">需要调用的核心模型 ID。</span>
          )}
        </div>

        <div className="settings-modal__field">
          <label className="settings-modal__label">上下文窗口 (Context Window)</label>
          <input
            type="number"
            className={`settings-modal__input${fieldErrors.contextWindow ? ' settings-modal__input--error' : ''}`}
            value={contextWindow}
            onChange={e => {
              const val = e.target.value
              setContextWindow(val === '' ? '' : Number(val))
              setFieldErrors(prev => ({ ...prev, contextWindow: undefined }))
            }}
            placeholder="例如 200000"
          />
          {fieldErrors.contextWindow ? (
            <span className="settings-modal__field-error">{fieldErrors.contextWindow}</span>
          ) : (
            <span className="settings-modal__help">留空时根据模型标识自动推断。</span>
          )}
        </div>

        <div className="settings-modal__field">
          <label className="settings-modal__label">图片输入 (Vision)</label>
          <select
            className="settings-modal__input settings-modal__select"
            value={supportsVision === null ? 'auto' : supportsVision ? 'on' : 'off'}
            onChange={e => {
              const val = e.target.value
              setSupportsVision(val === 'auto' ? null : val === 'on')
            }}
          >
            <option value="auto">
              自动推断（当前模型 {modelId.trim() || '?'} 推断为 {inferredVision ? '支持' : '不支持'}）
            </option>
            <option value="on">强制开启</option>
            <option value="off">强制关闭</option>
          </select>
          <span className="settings-modal__help">若自动推断与实际情况不符，可手动覆盖。</span>
        </div>

        {/* PRD §5.4：备用模型链（fallback） */}
        <div className="settings-modal__field">
          <label className="settings-modal__label">备用模型（Fallback）</label>
          <span className="settings-modal__help">
            主模型出现 429/5xx/超时且重试耗尽时，按顺序切换到这些模型继续任务。建议同家族/同上下文窗口。
          </span>
          <div className="llm-fallback-list">
            {fallbacks.map((fb, idx) => (
              <div key={idx} className="llm-fallback-item">
                <input
                  type="text"
                  className="settings-modal__input llm-fallback-item__model"
                  value={fb.modelId}
                  onChange={e => {
                    const next = [...fallbacks]
                    next[idx] = { ...fb, modelId: e.target.value }
                    setFallbacks(next)
                  }}
                  placeholder="模型 ID（如 gpt-4o-mini）"
                  disabled={saving}
                />
                <input
                  type="text"
                  className="settings-modal__input llm-fallback-item__url"
                  value={fb.baseUrl}
                  onChange={e => {
                    const next = [...fallbacks]
                    next[idx] = { ...fb, baseUrl: e.target.value }
                    setFallbacks(next)
                  }}
                  placeholder="Base URL"
                  disabled={saving}
                />
                <input
                  type="password"
                  className="settings-modal__input llm-fallback-item__key"
                  value={fb.apiKey}
                  onChange={e => {
                    const next = [...fallbacks]
                    next[idx] = { ...fb, apiKey: e.target.value }
                    setFallbacks(next)
                  }}
                  placeholder="API Key"
                  disabled={saving}
                />
                <button
                  type="button"
                  className="settings-modal__btn settings-modal__btn--cancel llm-fallback-item__remove"
                  onClick={() => setFallbacks(fallbacks.filter((_, i) => i !== idx))}
                  disabled={saving}
                  title="移除该备用模型"
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--cancel llm-fallback-add"
            onClick={() => setFallbacks([...fallbacks, { baseUrl: '', apiKey: '', modelId: '' }])}
            disabled={saving}
          >
            + 添加备用模型
          </button>
        </div>

        {submitError && <div className="settings-modal__error">{submitError}</div>}

        <div className="settings-modal__actions">
          <button
            type="button"
            className="settings-modal__btn settings-modal__btn--cancel"
            onClick={() => setConfigModalOpen(false)}
            disabled={saving}
          >
            取消
          </button>
          <button type="submit" className="settings-modal__btn settings-modal__btn--save" disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      </form>
    </div>
  )
}
