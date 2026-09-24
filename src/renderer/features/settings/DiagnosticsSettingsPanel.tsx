/**
 * DiagnosticsSettingsPanel — 诊断包导出面板
 *
 * 一键导出脱敏后的日志与系统信息 zip，供用户反馈问题时附上。
 * 内容边界（不含密钥、不含消息内容）由主进程收集侧保证。
 */
import React, { useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { SettingsPage, SettingsRow, SettingsSection } from './settingsKit'

export const DiagnosticsSettingsPanel: React.FC = () => {
  const [exporting, setExporting] = useState(false)
  const [resultText, setResultText] = useState<string | null>(null)

  const handleExport = async () => {
    setExporting(true)
    setResultText(null)
    try {
      const result = await window.api.invoke('diagnostics:export')
      if (result.status === 'saved') {
        setResultText(`已导出到 ${result.filePath}`)
      } else if (result.status === 'cancelled') {
        setResultText(null)
      } else {
        setResultText(`导出失败：${result.error}`)
      }
    } catch (err) {
      setResultText(`导出失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setExporting(false)
    }
  }

  return (
    <SettingsPage>
      <SettingsSection title="诊断" description="遇到问题时导出诊断包，附在反馈里能帮助定位。">
        <SettingsRow
          label="导出诊断包"
          description="包含最近 7 天主进程日志、系统信息、模型配置摘要与会话元数据。已自动脱敏：不含 API Key 与消息内容。"
          end={
            <Button
              label="导出诊断包"
              variant="secondary"
              isDisabled={exporting}
              onClick={() => void handleExport()}
            >
              {exporting ? '导出中…' : '导出诊断包'}
            </Button>
          }
        />
        {resultText ? <div className="settings-hint">{resultText}</div> : null}
      </SettingsSection>
    </SettingsPage>
  )
}
