/**
 * Inspector 文件 Tab：只读项目文件树 + 预览。
 */
import React, { useEffect, useMemo, useState } from 'react'
import {
  ArrowLeftIcon,
  ChevronIcon,
  FolderIcon,
  FileIcon,
  SearchIcon,
  RefreshIcon
} from '../../components/Icons'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { highlightLine } from '../diff/syntaxHighlight'
import { highlightLineCached } from '../../lib/highlightCache'
import type { FsEntry, FsReadFilePreviewResult } from '../../../shared/fs/types'
import {
  entryMatchesFilter,
  shouldForceExpand,
  useFileTreeStore
} from './useFileTreeStore'
import './InspectorPanel.css'

const TreeNode: React.FC<{
  entry: FsEntry
  depth: number
}> = ({ entry, depth }) => {
  const filter = useFileTreeStore(s => s.filter)
  const nodes = useFileTreeStore(s => s.nodes)
  const expanded = useFileTreeStore(s => s.expanded)
  const loading = useFileTreeStore(s => s.loading)
  const errors = useFileTreeStore(s => s.errors)
  const selectedFile = useFileTreeStore(s => s.selectedFile)
  const toggleExpand = useFileTreeStore(s => s.toggleExpand)
  const selectFile = useFileTreeStore(s => s.selectFile)
  const loadDir = useFileTreeStore(s => s.loadDir)

  if (!entryMatchesFilter(entry, filter, nodes)) return null

  const isDir = entry.type === 'directory'
  const forceOpen = isDir && shouldForceExpand(entry.relativePath, filter, nodes)
  const isOpen = forceOpen || !!expanded[entry.relativePath]
  const children = nodes[entry.relativePath]
  const isLoading = !!loading[entry.relativePath]
  const error = errors[entry.relativePath]
  const isSelected = selectedFile === entry.relativePath

  const onClick = () => {
    if (isDir) {
      toggleExpand(entry.relativePath)
    } else {
      selectFile(entry.relativePath)
    }
  }

  return (
    <div className="inspector-tree__node">
      <button
        type="button"
        className={`inspector-tree__row${isSelected ? ' inspector-tree__row--selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={onClick}
      >
        {isDir ? (
          <ChevronIcon size={12} direction={isOpen ? 'down' : 'right'} />
        ) : (
          <span className="inspector-tree__spacer" />
        )}
        {isDir ? <FolderIcon size={14} /> : <FileIcon size={14} />}
        <span className="inspector-tree__name">{entry.name}</span>
      </button>
      {isDir && isOpen && (
        <div className="inspector-tree__children">
          {isLoading && <div className="inspector-tree__hint">加载中…</div>}
          {error && (
            <div className="inspector-tree__error" style={{ paddingLeft: 8 + (depth + 1) * 14 }}>
              <span>{error}</span>
              <button
                type="button"
                className="inspector-tree__retry"
                onClick={() => void loadDir(entry.relativePath)}
              >
                重试
              </button>
            </div>
          )}
          {children?.map(child => (
            <TreeNode key={child.relativePath} entry={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/** 预览渲染行数上限：512KB 长文件全量成行会撑爆 DOM，超出截断并提示 */
const PREVIEW_RENDER_LINE_LIMIT = 2000

const FilePreview: React.FC<{ relativePath: string }> = ({ relativePath }) => {
  const selectFile = useFileTreeStore(s => s.selectFile)
  const [preview, setPreview] = useState<FsReadFilePreviewResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setPreview(null)
    void (async () => {
      try {
        const result = (await window.api.invoke('fs:read-file-preview', {
          relativePath
        })) as FsReadFilePreviewResult
        if (!cancelled) {
          setPreview(result)
          setLoading(false)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '读取失败')
          setLoading(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [relativePath])

  const { lines, lineCapped } = useMemo(() => {
    if (!preview || preview.binary) return { lines: [], lineCapped: false }
    const all = preview.content.split('\n')
    if (all.length <= PREVIEW_RENDER_LINE_LIMIT) return { lines: all, lineCapped: false }
    return { lines: all.slice(0, PREVIEW_RENDER_LINE_LIMIT), lineCapped: true }
  }, [preview])

  return (
    <div className="inspector-preview">
      <div className="inspector-preview__header">
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="返回文件树"
          onClick={() => selectFile(null)}
        >
          <ArrowLeftIcon size={14} />
        </button>
        <span className="inspector-preview__path" title={relativePath}>{relativePath}</span>
      </div>
      {preview?.truncated && (
        <div className="inspector-preview__banner">文件过大，仅显示前 512KB</div>
      )}
      {lineCapped && (
        <div className="inspector-preview__banner">仅显示前 {PREVIEW_RENDER_LINE_LIMIT} 行</div>
      )}
      {loading && <div className="inspector-empty__hint">加载中…</div>}
      {error && <div className="inspector-tree__error">{error}</div>}
      {preview?.binary && (
        <div className="inspector-empty">
          <p className="inspector-empty__title">二进制文件，无法预览</p>
        </div>
      )}
      {preview && !preview.binary && (
        <pre className="inspector-preview__code">
          {lines.map((line, idx) => {
            const tokens = highlightLineCached(line, relativePath, highlightLine)
            return (
              <div key={idx} className="inspector-preview__line">
                <span className="inspector-preview__lineno">{idx + 1}</span>
                <span className="inspector-preview__text">
                  {tokens.map((token, tIdx) => (
                    <span key={tIdx} className={`diff-token diff-token--${token.type}`}>{token.text}</span>
                  ))}
                </span>
              </div>
            )
          })}
        </pre>
      )}
    </div>
  )
}

const FileTreeView: React.FC = () => {
  const filter = useFileTreeStore(s => s.filter)
  const rootEntries = useFileTreeStore(s => s.nodes[''])
  const loadingRoot = useFileTreeStore(s => s.loading[''])
  const rootError = useFileTreeStore(s => s.errors[''])
  const setFilter = useFileTreeStore(s => s.setFilter)
  const collapseAll = useFileTreeStore(s => s.collapseAll)
  const refresh = useFileTreeStore(s => s.refresh)
  const loadDir = useFileTreeStore(s => s.loadDir)

  useEffect(() => {
    if (rootEntries === undefined && !loadingRoot) {
      void loadDir('')
    }
  }, [rootEntries, loadingRoot, loadDir])

  return (
    <div className="inspector-files">
      <div className="inspector-files__toolbar">
        <div className="inspector-files__search">
          <SearchIcon size={14} />
          <input
            type="search"
            className="inspector-files__search-input"
            placeholder="过滤文件…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="刷新"
          onClick={() => void refresh()}
        >
          <RefreshIcon size={14} />
        </button>
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="折叠全部"
          onClick={() => collapseAll()}
        >
          <ChevronIcon size={14} direction="up" />
        </button>
      </div>
      <div className="inspector-tree">
        {loadingRoot && rootEntries === undefined && (
          <div className="inspector-tree__hint">加载中…</div>
        )}
        {rootError && (
          <div className="inspector-tree__error">
            <span>{rootError}</span>
            <button
              type="button"
              className="inspector-tree__retry"
              onClick={() => void loadDir('')}
            >
              重试
            </button>
          </div>
        )}
        {rootEntries?.map(entry => (
          <TreeNode key={entry.relativePath} entry={entry} depth={0} />
        ))}
      </div>
    </div>
  )
}

export const FilesTab: React.FC = () => {
  const currentProjectPath = useWorkspaceStore(s => s.currentProjectPath)
  const selectedFile = useFileTreeStore(s => s.selectedFile)
  const reset = useFileTreeStore(s => s.reset)

  useEffect(() => {
    reset()
  }, [currentProjectPath, reset])

  if (!currentProjectPath) {
    return (
      <div className="inspector-empty">
        <FolderIcon size={28} />
        <p className="inspector-empty__title">选择项目后可浏览文件</p>
      </div>
    )
  }

  if (selectedFile) {
    return <FilePreview relativePath={selectedFile} />
  }

  return <FileTreeView />
}
