'use client';

/* eslint-disable @next/next/no-img-element */

import { useState, type ReactNode } from 'react';
import { ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StudioMediaThumbnailProps {
  src?: string | null;
  alt: string;
  className?: string;
  imageClassName?: string;
  fallback?: ReactNode;
  skeletonIcon?: ReactNode;
  loading?: 'lazy' | 'eager';
  children?: ReactNode;
}

export function StudioMediaThumbnail({
  src,
  alt,
  className,
  imageClassName,
  fallback,
  skeletonIcon,
  loading = 'lazy',
  children,
}: StudioMediaThumbnailProps) {
  const [imageState, setImageState] = useState<{
    src: string | null;
    status: 'loading' | 'loaded' | 'error';
  }>(() => ({
    src: src ?? null,
    status: src ? 'loading' : 'error',
  }));
  const normalizedSrc = src ?? null;
  const status = imageState.src === normalizedSrc
    ? imageState.status
    : normalizedSrc
      ? 'loading'
      : 'error';

  return (
    <div className={cn('relative h-full w-full overflow-hidden bg-muted', className)}>
      {status === 'loading' ? (
        <div className="absolute inset-0 z-[1] flex items-center justify-center overflow-hidden bg-muted" aria-hidden="true">
          <div className="absolute inset-0 animate-pulse bg-[radial-gradient(circle_at_25%_20%,hsl(var(--background)/0.75),transparent_30%),linear-gradient(135deg,hsl(var(--muted)),hsl(var(--accent)),hsl(var(--muted)))]" />
          <div className="relative flex h-12 w-12 items-center justify-center rounded-2xl border border-border/70 bg-background/65 text-muted-foreground shadow-sm">
            {skeletonIcon ?? <ImageIcon className="h-5 w-5" />}
          </div>
        </div>
      ) : null}

      {src && status !== 'error' ? (
        <img
          src={src}
          alt={alt}
          className={cn(
            'h-full w-full object-cover transition-opacity duration-200',
            status === 'loaded' ? 'opacity-100' : 'opacity-0',
            imageClassName,
          )}
          loading={loading}
          decoding="async"
          onLoad={() => setImageState({ src: normalizedSrc, status: 'loaded' })}
          onError={() => setImageState({ src: normalizedSrc, status: 'error' })}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
          {fallback ?? <ImageIcon className="h-8 w-8" />}
        </div>
      )}

      {children}
    </div>
  );
}
