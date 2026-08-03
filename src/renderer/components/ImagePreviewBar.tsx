import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { ImageAttachment } from '../lib/image-attachments'
import { Thumbnail } from '@astryxdesign/core/Thumbnail'
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
              <Thumbnail
                src={img.dataUrl}
                alt={img.fileName}
                label={img.fileName}
                onClick={() => onPreview?.(idx)}
                onRemove={() => onRemove(img.id)}
                showRemoveOn="always"
                className="image-preview-bar__thumb-btn"
              />
              <span className="image-preview-bar__name" title={img.fileName}>
                {img.fileName}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}
