'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface ModelImage {
  id: string;
  fileName: string;
}

interface ModelImagePreviewDialogProps {
  images: ModelImage[];
  initialIndex: number;
  entityId: string;
  entityType: 'product' | 'persona' | 'style';
  onClose: () => void;
}

export function ModelImagePreviewDialog({
  images,
  initialIndex,
  entityId,
  entityType,
  onClose,
}: ModelImagePreviewDialogProps) {
  const t = useTranslations('studio');
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCurrentIndex(initialIndex);
  }, [initialIndex]);

  const getImageUrl = (imageId: string) => {
    return entityType === 'product'
      ? `/api/studio/products/${entityId}/images/${imageId}`
      : entityType === 'persona'
        ? `/api/studio/personas/${entityId}/images/${imageId}`
        : `/api/studio/styles/${entityId}/images/${imageId}`;
  };

  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < images.length - 1;

  const handlePrev = useCallback(() => {
    if (!hasPrev) return;
    setCurrentIndex((i) => i - 1);
  }, [hasPrev]);

  const handleNext = useCallback(() => {
    if (!hasNext) return;
    setCurrentIndex((i) => i + 1);
  }, [hasNext]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handlePrev();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleNext();
      } else if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePrev, handleNext, onClose]);

  if (images.length === 0) return null;

  const currentImage = images[currentIndex];
  const fileName = currentImage?.fileName || 'image';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent layout="viewport" showCloseButton={false} className="flex h-full flex-col gap-0 p-0">
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">
          {t('modelDetail.imagePreviewDescription')}
        </DialogDescription>

        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{fileName}</p>
            {images.length > 1 && (
              <p className="text-xs text-muted-foreground">
                {currentIndex + 1} / {images.length}
              </p>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full items-center justify-center p-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={getImageUrl(currentImage.id)}
              alt={fileName}
              className="max-h-full max-w-full object-contain"
            />
          </div>

          {images.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute left-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
              onClick={handlePrev}
              disabled={!hasPrev}
              aria-label={t('modelDetail.previousImage')}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
          )}

          {images.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 z-10 -translate-y-1/2 rounded-full border border-border bg-background/90 shadow-sm backdrop-blur disabled:opacity-40"
              onClick={handleNext}
              disabled={!hasNext}
              aria-label={t('modelDetail.nextImage')}
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}