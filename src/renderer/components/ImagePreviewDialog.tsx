import React from 'react'
import { Lightbox } from '@astryxdesign/core/Lightbox'

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

/**
 * Full-screen attachment preview. Lightbox owns the dialog focus trap,
 * keyboard navigation and scroll lock while the caller remains the source of
 * the selected attachment index.
 */
export const ImagePreviewDialog: React.FC<ImagePreviewDialogProps> = ({
  images,
  currentIndex,
  isOpen,
  onClose,
  onNavigate
}) => {
  return (
    <Lightbox
      isOpen={isOpen}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
      media={images.map(image => ({
        src: image.dataUrl,
        alt: image.fileName,
        caption: image.fileName
      }))}
      index={currentIndex}
      onIndexChange={onNavigate}
    />
  )
}
