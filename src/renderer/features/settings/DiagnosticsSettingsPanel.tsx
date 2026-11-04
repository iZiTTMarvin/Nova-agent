/**
 * DiagnosticsSettingsPanel — 诊断包导出面板
 *
 * 导出脱敏后的日志与系统信息 zip，供排查与反馈问题使用。
 */
import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import {
  SettingsCard,
  SettingsCardRow,
  SettingsGlassPanel,
  SettingsPage
} from './settingsKit'

export const DiagnosticsSettingsPanel: React.FC = () => {
  const [exporting, setExporting] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)
  const [isError, setIsError] = useState(false)

  const handleExport = async () => {
    setExporting(true)
    setResultText(null)
    setIsError(false)
    try {
      const result = await window.api.invoke('diagnostics:export')
      if (result.status === 'saved') {
        setResultText(`已成功导出至：${result.filePath}`)
        setIsError(false)
      } else if (result.status === 'cancelled') {
        setResultText(null)
      } else {
        setResultText(`导出失败：${result.error}`)
        setIsError(true)
      }
    } catch (err) {
      setResultText(`导出失败：${err instanceof Error ? err.message : String(err)}`)
      setIsError(true)
    } finally {
      setExporting(false)
    }
  }

  return (
    <SettingsGlassPanel className="diagnostics-settings-panel">
      <div className="settings-panel__scroll">
        <SettingsPage>
          <SettingsCard
            title="应用诊断"
            description="导出运行日志与系统环境，便于排查异常。"
          >
            <SettingsCardRow
              label="导出诊断日志包"
              description="敏感密钥与对话内容会自动过滤。"
              control={
                <Button
                  label={exporting ? '导出中…' : '导出诊断包'}
                  variant="secondary"
                  size="sm"
                  isDisabled={exporting}
                  onClick={() => void handleExport()}
                >
                  {exporting ? '导出中…' : '导出诊断包'}
                </Button>
              }
            />
            {resultText && (
              <div
                className={`settings-status ${isError ? 'settings-status--error' : 'settings-status--ok'}`}
                style={{ marginTop: '4px' }}
              >
                {resultText}
              </div>
            )}
          </SettingsCard>
        </SettingsPage>
      </div>
    </SettingsGlassPanel>
  )
}
