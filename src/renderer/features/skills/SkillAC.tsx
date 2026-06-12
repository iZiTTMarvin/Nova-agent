/**
 * SkillAC — Composer `/` 自动补全浮层
 * 展示 name (skill) / name (command)，Nova 暖色主题
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'
import {
  type SlashCandidate,
  filterAndRankCandidates,
  listSlashCommands,
  skillsToCandidates
} from './slashCandidates'
import type { SkillSummary } from '../../../shared/skills/types'
import './SkillAC.css'

const IME_DEBOUNCE_MS = 20

export interface SkillACHandle {
  onKeyDown: (e: React.KeyboardEvent) => boolean
}

export interface SkillACProps {
  inputValue: string
  anchorRef: React.RefObject<HTMLElement | null>
  skills: SkillSummary[]
  onSelect: (slashText: string) => void
  isComposing?: boolean
}

export const SkillAC = forwardRef<SkillACHandle, SkillACProps>(function SkillAC(
  { inputValue, anchorRef, skills, onSelect, isComposing = false },
  ref
) {
  const [commands, setCommands] = useState<SlashCandidate[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [debouncedQuery, setDebouncedQuery] = useState(inputValue)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    void listSlashCommands().then(setCommands)
  }, [])

  useEffect(() => {
    if (isComposing) return
    const t = setTimeout(() => setDebouncedQuery(inputValue), IME_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [inputValue, isComposing])

  const slashToken = useMemo(() => {
    if (!debouncedQuery.startsWith('/')) return null
    return debouncedQuery.split(/\s/)[0] ?? ''
  }, [debouncedQuery])

  const allCandidates = useMemo(() => {
    return [...skillsToCandidates(skills), ...commands]
  }, [skills, commands])

  const filtered = useMemo(() => {
    if (!slashToken) return []
    return filterAndRankCandidates(slashToken.slice(1), allCandidates)
  }, [slashToken, allCandidates])

  const open = Boolean(slashToken) && filtered.length > 0 && !isComposing

  useEffect(() => {
    setActiveIndex(0)
  }, [debouncedQuery, filtered.length])

  const handleSelect = useCallback(
    (candidate: SlashCandidate) => {
      onSelect(`/${candidate.name} `)
    },
    [onSelect]
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!open) return false

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex(i => (i + 1) % filtered.length)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex(i => (i - 1 + filtered.length) % filtered.length)
        return true
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (filtered[activeIndex]) {
          e.preventDefault()
          handleSelect(filtered[activeIndex])
          return true
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        return true
      }
      return false
    },
    [open, filtered, activeIndex, handleSelect]
  )

  useImperativeHandle(ref, () => ({ onKeyDown }), [onKeyDown])

  const [position, setPosition] = useState({ bottom: 0, left: 0, width: 0 })

  useEffect(() => {
    if (!open || !anchorRef.current) return
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect()
      if (!rect) return
      setPosition({
        bottom: window.innerHeight - rect.top + 8,
        left: rect.left,
        width: rect.width
      })
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, anchorRef, debouncedQuery])

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  // 测试环境（react-test-renderer）无 document，跳过 Portal 渲染
  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <ul
      ref={listRef}
      className="skill-ac"
      role="listbox"
      style={{
        position: 'fixed',
        left: position.left,
        bottom: position.bottom,
        width: position.width,
        zIndex: 1100
      }}
    >
      {filtered.map((item, idx) => {
        const kindLabel = item.kind === 'skill' ? 'skill' : 'command'
        return (
          <li
            key={`${item.kind}:${item.name}`}
            role="option"
            aria-selected={idx === activeIndex}
            className={`skill-ac__item${idx === activeIndex ? ' skill-ac__item--active' : ''}`}
            onMouseDown={e => {
              e.preventDefault()
              handleSelect(item)
            }}
            onMouseEnter={() => setActiveIndex(idx)}
          >
            <div className="skill-ac__title">
              <span className="skill-ac__slash">/</span>
              {item.name}
              <span className="skill-ac__kind"> ({kindLabel})</span>
            </div>
            <div className="skill-ac__desc">{item.description}</div>
          </li>
        )
      })}
    </ul>,
    document.body
  )
})
