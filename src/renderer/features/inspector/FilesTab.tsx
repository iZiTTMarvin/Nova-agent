/**
 * Inspector 文件 Tab：只读项目文件树 + 预览。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftIcon,
  ChevronIcon,
  CloseIcon,
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
  const location = useFileTreeStore(s => s.selectedFileLocation)
  const codeRef = useRef<HTMLPreElement>(null)
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

  const { lines, lineCapped, firstLineNumber, totalLineCount } = useMemo(() => {
    if (!preview || preview.binary) {
      return { lines: [], lineCapped: false, firstLineNumber: 1, totalLineCount: 0 }
    }
    const all = preview.content.split('\n')
    const maxStart = Math.max(0, all.length - PREVIEW_RENDER_LINE_LIMIT)
    const start = location
      ? Math.min(Math.max(0, location.startLine - 101), maxStart)
      : 0
    return {
      lines: all.slice(start, start + PREVIEW_RENDER_LINE_LIMIT),
      lineCapped: all.length > PREVIEW_RENDER_LINE_LIMIT,
      firstLineNumber: start + 1,
      totalLineCount: all.length
    }
  }, [preview, location])

  useEffect(() => {
    if (!location || !preview || preview.binary) return
    const code = codeRef.current
    const target = code?.querySelector<HTMLElement>(`[data-line-number="${location.startLine}"]`)
    if (!code || !target) return
    const codeRect = code.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const top = code.scrollTop + targetRect.top - codeRect.top - (code.clientHeight - targetRect.height) / 2
    code.scrollTo({
      top: Math.max(0, top),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
    })
  }, [location, preview, firstLineNumber])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return
      }
      event.preventDefault()
      selectFile(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [selectFile])

  return (
    <div className="inspector-preview">
      <div className="inspector-preview__header">
        <button
          type="button"
          className="inspector-icon-btn"
          aria-label="返回文件树"
          title="返回文件树 (Esc)"
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
        <div className="inspector-preview__banner">
          仅显示第 {firstLineNumber}–{firstLineNumber + lines.length - 1} 行，共 {totalLineCount} 行
        </div>
      )}
      {loading && <div className="inspector-empty__hint">加载中…</div>}
      {error && <div className="inspector-tree__error">{error}</div>}
      {preview?.binary && (
        <div className="inspector-empty">
          <p className="inspector-empty__title">二进制文件，无法预览</p>
        </div>
      )}
      {preview && !preview.binary && (
        <pre ref={codeRef} className="inspector-preview__code">
          {lines.map((line, idx) => {
            const lineNumber = firstLineNumber + idx
            const tokens = highlightLineCached(line, relativePath, highlightLine)
            const isTarget = location !== null && lineNumber >= location.startLine && lineNumber <= (location.endLine ?? location.startLine)
            return (
              <div
                key={lineNumber}
                className="inspector-preview__line"
                data-line-number={lineNumber}
                data-read-target={isTarget ? 'true' : undefined}
              >
                <span className="inspector-preview__lineno">{lineNumber}</span>
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

function splitSearchPath(filePath: string): { dir: string; base: string } {
  const normalized = filePath.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  if (idx === -1) return { dir: '', base: normalized }
  return { dir: normalized.slice(0, idx), base: normalized.slice(idx + 1) }
}

const FileSearchResults: React.FC<{ paths: readonly string[] }> = ({ paths }) => {
  const selectedFile = useFileTreeStore(s => s.selectedFile)
  const selectFile = useFileTreeStore(s => s.selectFile)

  return (
    <div className="inspector-tree__search-results">
      {paths.map(path => {
        const { dir, base } = splitSearchPath(path)
        return (
          <button
            key={path}
            type="button"
            className={`inspector-tree__search-row${selectedFile === path ? ' inspector-tree__row--selected' : ''}`}
            title={path}
            onClick={() => selectFile(path)}
          >
            <FileIcon size={14} />
            <span className="inspector-tree__search-path">
              <span className="inspector-tree__search-base">{base}</span>
              {dir ? <span className="inspector-tree__search-dir">{dir}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

const FileTreeView: React.FC = () => {
  const filter = useFileTreeStore(s => s.filter)
  const filterMatches = useFileTreeStore(s => s.filterMatches)
  const filterLoading = useFileTreeStore(s => s.filterLoading)
  const filterError = useFileTreeStore(s => s.filterError)
  const rootEntries = useFileTreeStore(s => s.nodes[''])
  const loadingRoot = useFileTreeStore(s => s.loading[''])
  const rootError = useFileTreeStore(s => s.errors[''])
  const setFilter = useFileTreeStore(s => s.setFilter)
  const collapseAll = useFileTreeStore(s => s.collapseAll)
  const refresh = useFileTreeStore(s => s.refresh)
  const loadDir = useFileTreeStore(s => s.loadDir)
  const filterQuery = filter.trim()
  const searchInputRef = useRef<HTMLInputElement>(null)

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
            ref={searchInputRef}
            type="text"
            className="inspector-files__search-input"
            placeholder="过滤文件…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                if (filter) {
                  setFilter('')
                } else {
                  searchInputRef.current?.blur()
                }
              }
            }}
          />
          {filter && (
            <button
              type="button"
              className="inspector-files__search-clear"
              aria-label="清除文件过滤"
              title="清除过滤 (Esc)"
              onClick={() => {
                setFilter('')
                searchInputRef.current?.focus()
              }}
            >
              <CloseIcon size={12} />
            </button>
          )}
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
        {filterQuery ? (
          <>
            {filterLoading && <div className="inspector-tree__hint">搜索文件…</div>}
            {filterError && <div className="inspector-tree__error">{filterError}</div>}
            {!filterLoading && !filterError && filterMatches.length === 0 && (
              <div className="inspector-empty">
                <p className="inspector-empty__hint">未找到包含“{filter}”的文件</p>
              </div>
            )}
            {!filterLoading && !filterError && filterMatches.length > 0 && (
              <FileSearchResults paths={filterMatches} />
            )}
          </>
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  )
}

export const FilesTab: React.FC = () => {
  const currentProjectPath = useWorkspaceStore(s => s.currentProjectPath)
  const selectedFile = useFileTreeStore(s => s.selectedFile)

  if (!currentProjectPath) {
    return null
  }

  if (selectedFile) {
    return <FilePreview relativePath={selectedFile} />
  }

  return <FileTreeView />
}
