import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import './SettingsModal.css'

/** 各字段的校验错误信息 */
interface FieldErrors {
  baseUrl?: string
  apiKey?: string
  modelId?: string
}

export const SettingsModal: React.FC = () => {
  const isOpen = useAppStore(state => state.isConfigModalOpen)
  const modelConfig = useAppStore(state => state.modelConfig)
  const saveModelConfig = useAppStore(state => state.saveModelConfig)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 当弹窗打开或模型配置加载完毕时，填充默认值
  useEffect(() => {
    if (isOpen) {
      setBaseUrl(modelConfig?.baseUrl || 'https://api.openai.com/v1')
      setApiKey(modelConfig?.apiKey || '')
      setModelId(modelConfig?.modelId || 'gpt-4o')
      setFieldErrors({})
      setSubmitError(null)
      setShowKey(false)
    }
  }, [isOpen, modelConfig])

  if (!isOpen) return null

  /** 前端逐字段校验，返回是否全部通过 */
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

    if (!trimmedApiKey) {
      errors.apiKey = 'API Key 不能为空'
    }

    if (!trimmedModelId) {
      errors.modelId = '模型标识不能为空'
    }

    setFieldErrors(errors)
    return Object.keys(errors).length === 0
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    // 前端校验
    if (!validate()) return

    setSaving(true)
    setSubmitError(null)

    try {
      await saveModelConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelId: modelId.trim()
      })
      setConfigModalOpen(false)
    } catch (err) {
      // 后端 IPC 校验可能抛出包含多个字段错误的字符串（以中文分号分隔）
      setSubmitError(err instanceof Error ? err.message : '保存配置失败，请检查参数')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-modal-overlay" onClick={() => setConfigModalOpen(false)}>
      <div className="settings-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-modal__header">
          <h2 className="settings-modal__title">模型连接配置</h2>
          <button 
            className="settings-modal__close-btn" 
            onClick={() => setConfigModalOpen(false)}
            aria-label="关闭"
          >
            &times;
          </button>
        </div>

        <form className="settings-modal__form" onSubmit={handleSave}>
          <div className="settings-modal__field">
            <label className="settings-modal__label">接口地址 (Base URL)</label>
            <input 
              type="text" 
              className={`settings-modal__input${fieldErrors.baseUrl ? ' settings-modal__input--error' : ''}`}
              value={baseUrl}
              onChange={e => { setBaseUrl(e.target.value); setFieldErrors(prev => ({ ...prev, baseUrl: undefined })) }}
              placeholder="例如 https://api.openai.com/v1"
            />
            {fieldErrors.baseUrl 
              ? <span className="settings-modal__field-error">{fieldErrors.baseUrl}</span>
              : <span className="settings-modal__help">OpenAI 兼容接口的 API 根地址，通常含版本号如 /v1。</span>
            }
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">API 凭证 (API Key)</label>
            <div className="settings-modal__input-wrapper">
              <input 
                type={showKey ? 'text' : 'password'} 
                className={`settings-modal__input settings-modal__input--password${fieldErrors.apiKey ? ' settings-modal__input--error' : ''}`}
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setFieldErrors(prev => ({ ...prev, apiKey: undefined })) }}
                placeholder="sk-..."
              />
              <button 
                type="button"
                className="settings-modal__toggle-pwd"
                onClick={() => setShowKey(!showKey)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            {fieldErrors.apiKey
              ? <span className="settings-modal__field-error">{fieldErrors.apiKey}</span>
              : <span className="settings-modal__help">用于身份校验的 API Key。</span>
            }
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">模型标识 (Model ID)</label>
            <input 
              type="text" 
              className={`settings-modal__input${fieldErrors.modelId ? ' settings-modal__input--error' : ''}`}
              value={modelId}
              onChange={e => { setModelId(e.target.value); setFieldErrors(prev => ({ ...prev, modelId: undefined })) }}
              placeholder="例如 gpt-4o 或 claude-3-5-sonnet"
            />
            {fieldErrors.modelId
              ? <span className="settings-modal__field-error">{fieldErrors.modelId}</span>
              : <span className="settings-modal__help">需要调用的核心模型 ID。</span>
            }
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
            <button 
              type="submit" 
              className="settings-modal__btn settings-modal__btn--save"
              disabled={saving}
            >
              {saving ? '保存中...' : '保存配置'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
