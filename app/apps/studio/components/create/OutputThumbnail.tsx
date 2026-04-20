'use client';

/* eslint-disable @next/next/no-img-element */

import { Film, ImageIcon } from 'lucide-react';
import { OutputHoverOverlay } from './OutputHoverOverlay';

interface OutputThumbnailProps {
  mediaUrl: string | null;
  filePath: string;
  title: string;
  type: 'image' | 'video';
  generationMode: string;
}

export function OutputThumbnail({
  mediaUrl,
  filePath,
  title,
  type,
  generationMode,
}: OutputThumbnailProps) {
  return (
    <button
      type="button"
      className="group relative aspect-square overflow-hidden rounded-3xl border border-border/70 bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md"
      disabled
    >
      {mediaUrl ? (
        type === 'video' ? (
          <video className="h-full w-full object-cover" src={mediaUrl} muted playsInline />
        ) : (
          <img
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
            src={mediaUrl}
            alt={filePath}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center bg-muted text-muted-foreground">
          <ImageIcon className="h-8 w-8" />
        </div>
      )}

      <OutputHoverOverlay mediaUrl={mediaUrl} type={type} />

      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/80 via-black/25 to-transparent px-3 pb-3 pt-10 text-white">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/70">{generationMode}</div>
          <div className="truncate text-sm font-semibold">{title}</div>
        </div>
        {type === 'video' ? <Film className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
      </div>
    </button>
  );
}
