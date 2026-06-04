import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CloseIcon } from './Icons'
import type { ImageAttachment } from '../lib/image-attachments'
import './ImagePreviewBar.css'

interface ImagePreviewBarProps {
  attachments: ImageAttachment[]
  onRemove: (id: string) => void
  onPreview?: (index: number) => void
}

export const ImagePreviewBar: React.FC<ImagePreviewBarProps> = ({
  attachments,
  onRemove,
  onPreview
}) => {
  if (attachments.length === 0) return null

  return (
    <div className="image-preview-bar">
      <div className="image-preview-bar__track">
        <AnimatePresence mode="popLayout" initial={false}>
          {attachments.map((img, idx) => (
            <motion.div
              key={img.id}
              layout
              initial={{ opacity: 0, scale: 0.85, y: 6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 400, damping: 28 }}
              className="image-preview-bar__item"
            >
              <button
                className="image-preview-bar__thumb-btn"
                onClick={() => onPreview?.(idx)}
                title={img.fileName}
                type="button"
              >
                <img
                  src={img.dataUrl}
                  alt={img.fileName}
                  className="image-preview-bar__thumb"
                  draggable={false}
                />
              </button>
              <span className="image-preview-bar__name" title={img.fileName}>
                {img.fileName}
              </span>
              <button
                className="image-preview-bar__remove"
                onClick={() => onRemove(img.id)}
                title="移除图片"
                type="button"
              >
                <CloseIcon size={10} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
