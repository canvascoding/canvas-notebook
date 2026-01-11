'use client';
/* eslint-disable @next/next/no-img-element */

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps) {
  const previewSrc = toPreviewUrl(path, 1280);
  const fullSrc = toMediaUrl(path);
  const name = path.split('/').pop() || 'image';
  const [hasError, setHasError] = useState(false);
  const [src, setSrc] = useState(previewSrc);

  return (
    <div className="relative flex h-full items-center justify-center bg-slate-900">
      {hasError ? (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <AlertCircle className="h-4 w-4" />
          Failed to load image.
        </div>
      ) : (
        // Use native img to avoid Next/Image loader constraints for local API streams.
        <img
          src={src}
          alt={name}
          className="max-h-full max-w-full object-contain"
          loading="lazy"
          decoding="async"
          onError={() => {
            if (src !== fullSrc) {
              setSrc(fullSrc);
            } else {
              setHasError(true);
            }
          }}
        />
      )}
    </div>
  );
}
