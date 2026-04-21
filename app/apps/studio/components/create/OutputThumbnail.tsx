'use client';

/* eslint-disable @next/next/no-img-element */

import { Film, ImageIcon } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { OutputHoverOverlay } from './OutputHoverOverlay';

interface OutputThumbnailProps {
  id: string;
  mediaUrl: string | null;
  filePath: string;
  title: string;
  type: 'image' | 'video';
  generationMode: string;
  generation: StudioGeneration;
  output: StudioGenerationOutput;
  onOpen: (outputId: string) => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

export function OutputThumbnail({
  id,
  mediaUrl,
  filePath,
  title,
  type,
  generationMode,
  generation,
  output,
  onOpen,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
  onDelete,
}: OutputThumbnailProps) {
  return (
    <div className="group relative aspect-square overflow-hidden rounded-3xl border border-border/70 bg-card text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <button type="button" className="absolute inset-0 z-0 cursor-pointer" onClick={() => onOpen(id)} aria-label={`Open ${title}`}>
        <span className="sr-only">{title}</span>
      </button>

      <div className="relative z-[1] h-full w-full pointer-events-none">
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
      </div>

      <div className="relative z-[2]">
        <OutputHoverOverlay
          mediaUrl={mediaUrl}
          type={type}
          isFavorite={output.isFavorite}
          generation={generation}
          output={output}
          onToggleFavorite={onToggleFavorite}
          onCreateVariation={onCreateVariation}
          onCreateVideo={onCreateVideo}
          onDelete={onDelete}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1] flex items-center justify-between bg-gradient-to-t from-black/80 via-black/25 to-transparent px-3 pb-3 pt-10 text-white">
        <div className="min-w-0">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-white/70">{generationMode}</div>
          <div className="truncate text-sm font-semibold">{title}</div>
        </div>
        {type === 'video' ? <Film className="h-4 w-4" /> : <ImageIcon className="h-4 w-4" />}
      </div>
    </div>
  );
}
