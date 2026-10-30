/**
 * FileTypeIcon — 过程行里的文件类型图标。
 *
 * 按扩展名归为文档、代码、标记样式、数据四类，用图形与色调区分；
 * 不再用文字徽标，避免 HTML 等长扩展名在 16px 槽位里被裁切。
 */
import React from 'react'
import { FileBracesIcon, FileCodeIcon, FileIcon, FileTextIcon } from '../../components/Icons'
import './FileTypeIcon.css'

type FileTypeTone = 'doc' | 'code' | 'markup' | 'data'

const DOC_EXTS = new Set(['md', 'markdown', 'mdx', 'txt', 'rst'])
const MARKUP_EXTS = new Set(['html', 'htm', 'css', 'scss', 'less', 'svg', 'xml', 'vue'])
const DATA_EXTS = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml'])
const CODE_EXTS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs',
  'java', 'kt', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'sh', 'ps1', 'sql'
])

function resolveTone(ext: string): FileTypeTone | null {
  if (DOC_EXTS.has(ext)) return 'doc'
  if (MARKUP_EXTS.has(ext)) return 'markup'
  if (DATA_EXTS.has(ext)) return 'data'
  if (CODE_EXTS.has(ext)) return 'code'
  return null
}

const ICON_SIZE = 14

export function FileTypeIcon({ ext, className }: { ext: string; className?: string }) {
  const tone = resolveTone(ext.toLowerCase())
  const classes = ['file-type-icon', tone ? `file-type-icon--${tone}` : '', className ?? '']
    .filter(Boolean)
    .join(' ')

  if (tone === 'doc') return <FileTextIcon size={ICON_SIZE} className={classes} />
  if (tone === 'data') return <FileBracesIcon size={ICON_SIZE} className={classes} />
  if (tone === 'code' || tone === 'markup') return <FileCodeIcon size={ICON_SIZE} className={classes} />
  return <FileIcon size={ICON_SIZE} className={classes} />
}
