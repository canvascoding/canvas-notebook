'use client';

import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

type SafeMarkdownImageProps = {
  src: string;
  previewSrc?: string;
  openSrc?: string;
  alt?: string;
  wrapperClassName?: string;
  imageClassName?: string;
  errorClassName?: string;
  errorLabel?: string;
  showError?: boolean;
  onOpen?: (src: string) => void;
};

export function SafeMarkdownImage({
  src,
  previewSrc,
  openSrc,
  alt = '',
  wrapperClassName,
  imageClassName,
  errorClassName,
  errorLabel = 'Image could not be loaded.',
  showError = false,
  onOpen,
}: SafeMarkdownImageProps) {
  const displaySrc = previewSrc || src;
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!displaySrc || loadedSrc === displaySrc || failedSrc === displaySrc) {
      return;
    }

    let cancelled = false;
    const image = new window.Image();

    image.onload = () => {
      if (!cancelled) {
        setLoadedSrc(displaySrc);
      }
    };
    image.onerror = () => {
      if (!cancelled) {
        setFailedSrc(displaySrc);
      }
    };
    image.src = displaySrc;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
    };
  }, [displaySrc, failedSrc, loadedSrc]);

  // Render a placeholder while loading to prevent layout shift in chat scroll.
  if (!displaySrc || loadedSrc !== displaySrc) {
    if (showError && failedSrc === displaySrc) {
      return (
        <span
          role="img"
          aria-label={errorLabel}
          title={displaySrc}
          className={cn(
            'inline-flex max-w-full items-center rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive',
            errorClassName,
          )}
        >
          {errorLabel}
        </span>
      );
    }

    // Placeholder: reserve vertical space so the chat doesn't jump when the image loads.
    return (
      <span
        className={cn(
          'block min-h-[160px] w-full rounded-md border border-border/40 bg-muted/60',
          wrapperClassName,
        )}
      />
    );
  }

  const image = (
    // Markdown image sources can be arbitrary user-provided URLs, so next/image
    // domain restrictions are not a good fit for this renderer.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={displaySrc}
      alt={alt}
      className={imageClassName}
      loading="lazy"
      decoding="async"
      onError={() => setFailedSrc(displaySrc)}
    />
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className={cn(wrapperClassName, 'cursor-pointer')}
        onClick={() => onOpen(openSrc || src)}
      >
        {image}
      </button>
    );
  }

  if (wrapperClassName) {
    return <span className={wrapperClassName}>{image}</span>;
  }

  return image;
}
