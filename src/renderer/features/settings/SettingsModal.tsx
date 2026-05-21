import React, { useState, useEffect } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import './SettingsModal.css'

export const SettingsModal: React.FC = () => {
  const isOpen = useAppStore(state => state.isConfigModalOpen)
  const modelConfig = useAppStore(state => state.modelConfig)
  const saveModelConfig = useAppStore(state => state.saveModelConfig)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)

  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // 当弹窗打开或模型配置加载完毕时，填充默认值
  useEffect(() => {
    if (isOpen) {
      setBaseUrl(modelConfig?.baseUrl || 'https://api.openai.com/v1')
      setApiKey(modelConfig?.apiKey || '')
      setModelId(modelConfig?.modelId || 'gpt-4o')
      setError(null)
      setShowKey(false)
    }
  }, [isOpen, modelConfig])

  if (!isOpen) return null

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!baseUrl.trim()) {
      setError('接口地址 (Base URL) 不能为空')
      return
    }
    if (!apiKey.trim()) {
      setError('API Key 不能为空')
      return
    }
    if (!modelId.trim()) {
      setError('模型标识 (Model ID) 不能为空')
      return
    }

    setSaving(true)
    setError(null)

    try {
      await saveModelConfig({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelId: modelId.trim()
      })
      setConfigModalOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存配置失败，请检查参数')
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
              className="settings-modal__input"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="例如 https://api.openai.com/v1"
            />
            <span className="settings-modal__help">OpenAI 兼容接口的统一访问根地址。</span>
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">API 凭证 (API Key)</label>
            <div className="settings-modal__input-wrapper">
              <input 
                type={showKey ? 'text' : 'password'} 
                className="settings-modal__input settings-modal__input--password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
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
            <span className="settings-modal__help">用于身份校验的 API Key。</span>
          </div>

          <div className="settings-modal__field">
            <label className="settings-modal__label">模型标识 (Model ID)</label>
            <input 
              type="text" 
              className="settings-modal__input"
              value={modelId}
              onChange={e => setModelId(e.target.value)}
              placeholder="例如 gpt-4o 或 claude-3-5-sonnet"
            />
            <span className="settings-modal__help">需要调用的核心模型 ID。</span>
          </div>

          {error && <div className="settings-modal__error">{error}</div>}

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
