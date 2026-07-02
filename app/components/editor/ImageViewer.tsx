'use client';
/* eslint-disable @next/next/no-img-element */

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { toMediaUrl, toPreviewUrl } from '@/app/lib/utils/media-url';
import { useWorkspaceStore } from '@/app/store/workspace-store';

interface ImageViewerProps {
  path: string;
  previewSrc?: string;
  fullSrc?: string;
}

interface ImageContentProps {
  previewSrc: string;
  fullSrc: string;
  name: string;
}

function ImageContent({ previewSrc, fullSrc, name }: ImageContentProps) {
  const [hasError, setHasError] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [src, setSrc] = useState(previewSrc);

  if (hasError) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlertCircle className="h-4 w-4" />
        Failed to load image.
      </div>
    );
  }

  return (
    <>
      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="flex h-full w-full max-w-5xl items-center justify-center">
            <Skeleton className="h-full max-h-[min(70vh,720px)] w-full max-w-full rounded-lg" />
          </div>
        </div>
      )}
      <img
        src={src}
        alt={name}
        className={`max-h-full max-w-full object-contain transition-opacity duration-200 ${isLoaded ? 'opacity-100' : 'opacity-0'}`}
        loading="lazy"
        decoding="async"
        onLoad={() => setIsLoaded(true)}
        onError={() => {
          if (src !== fullSrc) {
            setIsLoaded(false);
            setSrc(fullSrc);
          } else {
            setHasError(true);
          }
        }}
      />
    </>
  );
}

export function ImageViewer({ path, previewSrc, fullSrc }: ImageViewerProps) {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const resolvedPreviewSrc = previewSrc ?? toPreviewUrl(path, 1280, { workspaceId });
  const resolvedFullSrc = fullSrc ?? toMediaUrl(path, { workspaceId });
  const name = path.split('/').pop() || 'image';

  return (
    <div className="relative flex h-full items-center justify-center bg-background">
      {/* Use native img to avoid Next/Image loader constraints for local API streams. */}
      <ImageContent key={`${path}-${resolvedPreviewSrc}`} previewSrc={resolvedPreviewSrc} fullSrc={resolvedFullSrc} name={name} />
    </div>
  );
}
