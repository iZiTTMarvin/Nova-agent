import React, { useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CloseIcon } from './Icons'
import './ImagePreviewDialog.css'

interface PreviewImage {
  dataUrl: string
  fileName: string
}

interface ImagePreviewDialogProps {
  images: PreviewImage[]
  currentIndex: number
  isOpen: boolean
  onClose: () => void
  onNavigate: (index: number) => void
}

export const ImagePreviewDialog: React.FC<ImagePreviewDialogProps> = ({
  images,
  currentIndex,
  isOpen,
  onClose,
  onNavigate
}) => {
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < images.length - 1

  const handlePrev = useCallback(() => {
    if (hasPrev) onNavigate(currentIndex - 1)
  }, [hasPrev, currentIndex, onNavigate])

  const handleNext = useCallback(() => {
    if (hasNext) onNavigate(currentIndex + 1)
  }, [hasNext, currentIndex, onNavigate])

  // 键盘导航
  useEffect(() => {
    if (!isOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') handlePrev()
      if (e.key === 'ArrowRight') handleNext()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [isOpen, onClose, handlePrev, handleNext])

  // 禁止 body 滚动
  useEffect(() => {
    if (isOpen) {
      const prev = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      return () => { document.body.style.overflow = prev }
    }
  }, [isOpen])

  const current = images[currentIndex]
  if (!current) return null

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="image-preview-dialog"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={onClose}
        >
          {/* 关闭按钮 */}
          <button
            className="image-preview-dialog__close"
            onClick={onClose}
            type="button"
            aria-label="关闭预览"
          >
            <CloseIcon size={20} />
          </button>

          {/* 图片计数器 */}
          {images.length > 1 && (
            <div className="image-preview-dialog__counter">
              {currentIndex + 1} / {images.length}
            </div>
          )}

          {/* 上一张 */}
          {hasPrev && (
            <button
              className="image-preview-dialog__nav image-preview-dialog__nav--prev"
              onClick={(e) => { e.stopPropagation(); handlePrev() }}
              type="button"
              aria-label="上一张"
            >
              ←
            </button>
          )}

          {/* 下一张 */}
          {hasNext && (
            <button
              className="image-preview-dialog__nav image-preview-dialog__nav--next"
              onClick={(e) => { e.stopPropagation(); handleNext() }}
              type="button"
              aria-label="下一张"
            >
              →
            </button>
          )}

          {/* 主图 */}
          <motion.div
            className="image-preview-dialog__stage"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <img
              src={current.dataUrl}
              alt={current.fileName}
              className="image-preview-dialog__img"
              draggable={false}
            />
            <div className="image-preview-dialog__filename">{current.fileName}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
