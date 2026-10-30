/**
 * 获取可用模型：拉取服务商模型列表，由用户勾选后只添加所选。
 * 已在目录中的模型锁定为已勾选；新模型默认不勾选，避免大型服务商一次灌入上百项。
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { Dialog } from '@astryxdesign/core/Dialog'
import { IconButton } from '@astryxdesign/core/IconButton'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { CheckSmallIcon, CloseIcon, SearchIcon } from '../../components/Icons'
import type { ProviderConfig } from '../../../shared/config/llmRegistry'

interface LlmModelPickerProps {
  provider: Pick<ProviderConfig, 'id' | 'name' | 'baseUrl' | 'apiKey' | 'models'>
  onClose: () => void
  onConfirm: (modelIds: string[]) => void
}

type FetchState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; modelIds: string[] }

const TITLE_ID = 'llm-model-picker-title'
// 只有前若干行播入场动画，长列表不会同时挂上几百个动画
const STAGGER_ROWS = 14

export const LlmModelPicker: React.FC<LlmModelPickerProps> = ({ provider, onClose, onConfirm }) => {
  const fetchProviderModels = useSettingsStore(state => state.fetchProviderModels)
  const [state, setState] = useState<FetchState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')

  const { id, baseUrl, apiKey } = provider
  const existing = useMemo(() => new Set(provider.models.map(m => m.modelId)), [provider.models])

  // 重试或关闭后旧请求的结果必须丢弃，否则会覆盖当前状态
  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetchProviderModels(baseUrl, apiKey, id)
      .then(result => {
        if (cancelled) return
        setState(result.ok
          ? { status: 'ready', modelIds: [...new Set(result.modelIds)] }
          : { status: 'error', message: result.message })
      })
      .catch(err => {
        if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : '拉取失败' })
      })
    return () => { cancelled = true }
  }, [fetchProviderModels, baseUrl, apiKey, id, attempt])

  const modelIds = state.status === 'ready' ? state.modelIds : []
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? modelIds.filter(m => m.toLowerCase().includes(needle)) : modelIds
  }, [modelIds, query])
  const selectableVisible = visible.filter(m => !existing.has(m))

  const toggle = (modelId: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(modelId)) next.delete(modelId)
      else next.add(modelId)
      return next
    })
  }

  const confirm = () => onConfirm(modelIds.filter(m => selected.has(m)))

  return (
    <Dialog
      isOpen
      purpose="form"
      width="min(560px, calc(100vw - 32px))"
      padding={0}
      className="llm-picker"
      aria-labelledby={TITLE_ID}
      onOpenChange={open => { if (!open) onClose() }}
    >
      <div className="llm-picker__body">
        <header className="llm-picker__header">
          <div className="llm-picker__heading">
            <h3 id={TITLE_ID} className="llm-picker__title">选择要添加的模型</h3>
            <p className="llm-picker__summary">
              {state.status === 'ready'
                ? `${provider.name} 返回 ${modelIds.length} 个模型，已添加 ${modelIds.filter(m => existing.has(m)).length} 个`
                : provider.name}
            </p>
          </div>
          <IconButton
            label="关闭"
            icon={<CloseIcon size={14} />}
            variant="ghost"
            size="sm"
            onClick={onClose}
          />
        </header>

        <div className="llm-picker__toolbar">
          <label className="llm-picker__search">
            <SearchIcon size={14} aria-hidden="true" />
            <input
              type="search"
              placeholder="搜索模型"
              aria-label="搜索模型"
              value={query}
              onChange={e => setQuery(e.target.value)}
              disabled={state.status !== 'ready'}
              autoFocus
            />
          </label>
          <button
            type="button"
            className="llm-picker__link"
            onClick={() => setSelected(prev => new Set([...prev, ...selectableVisible]))}
            disabled={selectableVisible.length === 0}
          >
            全选
          </button>
          <button
            type="button"
            className="llm-picker__link"
            onClick={() => setSelected(new Set())}
            disabled={selected.size === 0}
          >
            清空
          </button>
        </div>

        <div className="llm-picker__list" role="group" aria-label="可用模型">
          {state.status === 'loading' && (
            <div className="llm-picker__skeleton" aria-busy="true" aria-label="正在获取模型">
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className="llm-picker__skeleton-row" style={{ '--i': i } as React.CSSProperties} />
              ))}
            </div>
          )}
          {state.status === 'error' && (
            <div className="llm-picker__notice" role="alert">
              <p>{state.message}</p>
              <Button label="重试" variant="secondary" size="sm" onClick={() => setAttempt(n => n + 1)}>
                重试
              </Button>
            </div>
          )}
          {state.status === 'ready' && visible.length === 0 && (
            <p className="llm-picker__notice">没有匹配的模型</p>
          )}
          {visible.map((modelId, index) => {
            const added = existing.has(modelId)
            const checked = added || selected.has(modelId)
            return (
              <label
                key={modelId}
                className={`llm-picker__row${checked ? ' llm-picker__row--checked' : ''}${added ? ' llm-picker__row--added' : ''}${index < STAGGER_ROWS ? ' llm-picker__row--enter' : ''}`}
                style={{ '--i': index } as React.CSSProperties}
              >
                <input
                  type="checkbox"
                  className="llm-picker__input"
                  checked={checked}
                  disabled={added}
                  onChange={() => toggle(modelId)}
                />
                <span className="llm-picker__check" aria-hidden="true">
                  <CheckSmallIcon size={12} />
                </span>
                <span className="llm-picker__id">{modelId}</span>
                {added && <span className="llm-picker__tag">已添加</span>}
              </label>
            )
          })}
        </div>

        <footer className="llm-picker__footer">
          <Button label="取消" variant="secondary" className="llm-glass-btn" onClick={onClose}>取消</Button>
          <Button
            label={`添加所选 ${selected.size}`}
            variant="primary"
            className="llm-glass-btn llm-glass-btn--primary"
            onClick={confirm}
            isDisabled={selected.size === 0}
          >
            {selected.size > 0 ? `添加所选 (${selected.size})` : '添加所选'}
          </Button>
        </footer>
      </div>
    </Dialog>
  )
}
