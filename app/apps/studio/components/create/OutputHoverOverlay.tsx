'use client';

import { Download, Film, RefreshCcw, Star } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { Button } from '@/components/ui/button';

interface OutputHoverOverlayProps {
  mediaUrl: string | null;
  type: 'image' | 'video';
  isFavorite: boolean;
  generation: StudioGeneration;
  output: StudioGenerationOutput;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

export function OutputHoverOverlay({
  mediaUrl,
  type,
  isFavorite,
  generation,
  output,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
}: OutputHoverOverlayProps) {
  const handleDownload = () => {
    if (!mediaUrl) return;
    window.open(mediaUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/75 via-black/10 to-black/25 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
      <div className="flex justify-end">
        <span className="rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80">
          {type}
        </span>
      </div>

      <div className="pointer-events-auto flex justify-end gap-2">
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 rounded-full bg-black/55 text-white hover:bg-black/70" onClick={handleDownload}>
          <Download className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 rounded-full bg-black/55 text-white hover:bg-black/70" onClick={() => onToggleFavorite(generation, output)}>
          <Star className={`h-4 w-4 ${isFavorite ? 'fill-current text-amber-300' : ''}`} />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 rounded-full bg-black/55 text-white hover:bg-black/70" onClick={() => onCreateVariation(generation, output)}>
          <RefreshCcw className="h-4 w-4" />
        </Button>
        <Button type="button" size="icon" variant="secondary" className="h-9 w-9 rounded-full bg-black/55 text-white hover:bg-black/70" onClick={() => onCreateVideo(generation, output)} disabled={type !== 'image'}>
          <Film className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
