/**
 * WebSearch 设置面板 — 配置 Tavily API Key
 * API key 通过 settings:set 持久化到 ~/.nova/settings.json
 */
import React, { useEffect, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { TextInput } from '@astryxdesign/core/TextInput'
import { SettingsCard, SettingsGlassPanel, SettingsPage } from './settingsKit'
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
        <div className="settings-panel__scroll">
          <p className="settings-panel__muted">加载中…</p>
        </div>
      </div>
    )
  }

  return (
    <SettingsGlassPanel className="websearch-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsCard
            title="Tavily 增强搜索"
            description="默认使用内置免密钥搜索；配置 Tavily 可提升复杂检索与网页抓取质量。"
          >
            <div style={{ display: "grid", gap: "10px" }}>
              <TextInput
                label="Tavily API Key（可选）"
                type="password"
                placeholder="tvly-xxxxxxxxxxxxxxxx"
                value={draftKey}
                onChange={value => setDraftKey(value)}
                onBlur={() => void saveApiKey()}
                isDisabled={saving}
                width="100%"
              />
              <span className="settings-help">
                Key 仅保存在本机环境中。{" "}
                <a
                  href="https://app.tavily.com"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  获取 Tavily API Key →
                </a>
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
              <Button
                label={saving ? "保存中…" : "保存配置"}
                variant="primary"
                size="sm"
                isDisabled={saving}
                onClick={() => void saveApiKey()}
              >
                {saving ? "保存中…" : "保存配置"}
              </Button>
              {saved && !error && (
                <span className="settings-status settings-status--ok">已保存</span>
              )}
              {error && (
                <span className="settings-status settings-status--error">{error}</span>
              )}
            </div>
          </SettingsCard>
        </SettingsPage>
      </div>
    </SettingsGlassPanel>
  )
}
