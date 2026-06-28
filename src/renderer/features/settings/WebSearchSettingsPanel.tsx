/**
 * WebSearch 设置面板 — 配置 Tavily API Key
 * API key 通过 settings:set 持久化到 ~/.nova/settings.json
 */
import React, { useEffect, useState } from 'react'
import type { NovaSettingsDto } from '../../../shared/settings/types'

export const WebSearchSettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<NovaSettingsDto | null>(null)
  const [draftKey, setDraftKey] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const s = await window.api.invoke('settings:get')
      setSettings(s)
      setDraftKey(s.webSearchTavilyApiKey ?? '')
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载设置失败')
    }
  }

  /** 保存 API Key（blur 或点击保存按钮时调用） */
  const saveApiKey = async (): Promise<void> => {
    if (!settings) return
    const trimmed = draftKey.trim()
    if (trimmed === (settings.webSearchTavilyApiKey ?? '')) return

    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await window.api.invoke('settings:set', {
        webSearchTavilyApiKey: trimmed || undefined
      })
      setSettings(next)
      setDraftKey(next.webSearchTavilyApiKey ?? '')
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1500)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  if (!settings) {
    return (
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h3 className="settings-panel__title">联网搜索</h3>
        </header>
        <div className="settings-panel__scroll">加载中…</div>
      </div>
    )
  }

  return (
    <div className="settings-panel">
      <header className="settings-panel__header">
        <h3 className="settings-panel__title">联网搜索</h3>
        <p className="settings-panel__desc">
          无需配置 API Key 也可通过 Bing / DuckDuckGo 联网搜索。填写 Tavily API Key 可在爬虫失败时作为质量增强兜底。
        </p>
      </header>

      <div className="settings-modal__form settings-panel__scroll">
        <div className="settings-modal__field">
          <label className="settings-modal__label" htmlFor="tavily-api-key">
            Tavily API Key（可选）
          </label>
          <input
            id="tavily-api-key"
            type="password"
            className="settings-modal__input"
            placeholder="tvly-xxxxxxxxxxxxxxxx"
            value={draftKey}
            onChange={e => setDraftKey(e.target.value)}
            onBlur={() => void saveApiKey()}
            disabled={saving}
          />
          <span className="settings-modal__help">
            不填也能搜索；填写后可提升搜索质量，并在爬虫失败时自动兜底。Key 仅保存在本机。
            {' '}
            <a
              href="https://app.tavily.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              获取 Tavily API Key →
            </a>
          </span>
        </div>

        <div className="settings-modal__field">
          <button
            type="button"
            className="settings-panel__primary-btn"
            disabled={saving}
            onClick={() => void saveApiKey()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>

        {error && <div className="settings-modal__error">{error}</div>}
        {saved && !error && (
          <div className="settings-modal__help" style={{ color: 'var(--color-success, #2da44e)' }}>
            已保存
          </div>
        )}
      </div>
    </div>
  )
}
