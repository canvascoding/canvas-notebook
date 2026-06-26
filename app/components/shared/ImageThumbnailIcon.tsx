'use client';

import { useState, type ReactNode } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';

interface ImageThumbnailIconProps {
  path: string;
  name: string;
  workspaceId?: string | null;
  className?: string;
  imageClassName?: string;
  fallbackIcon?: ReactNode;
}

export function ImageThumbnailIcon({
  path,
  name,
  workspaceId,
  className,
  imageClassName,
  fallbackIcon,
}: ImageThumbnailIconProps) {
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center', className)}>
        {fallbackIcon ?? <ImageIcon className="h-4 w-4 text-chart-5" />}
      </span>
    );
  }

  return (
    <span className={cn('block h-5 w-5 shrink-0 overflow-hidden rounded border border-border/70 bg-muted/40', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={toPreviewUrl(path, 64, { preset: 'mini', workspaceId })}
        alt={name}
        className={cn('h-full w-full object-cover', imageClassName)}
        loading="lazy"
        decoding="async"
        onError={() => setHasError(true)}
      />
    </span>
  );
}
