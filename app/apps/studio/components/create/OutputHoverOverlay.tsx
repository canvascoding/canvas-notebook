'use client';

import { Download, Film, RefreshCcw, Star, Trash2 } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useState } from 'react';

interface OutputHoverOverlayProps {
  mediaUrl: string | null;
  type: 'image' | 'video';
  isFavorite: boolean;
  generation: StudioGeneration;
  output: StudioGenerationOutput;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
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
  onDelete,
}: OutputHoverOverlayProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleDownload = () => {
    if (!mediaUrl) return;
    window.open(mediaUrl, '_blank', 'noopener,noreferrer');
  };

  const handleDelete = () => {
    setShowDeleteDialog(false);
    onDelete(generation, output);
  };

  return (
    <>
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/75 via-black/10 to-black/25 p-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <div className="flex justify-end">
          <span className="rounded-full bg-black/45 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80">
            {type}
          </span>
        </div>

        <div className="pointer-events-auto flex items-end justify-between">
          <Button
            type="button"
            size="icon"
            variant="secondary"
            className="h-9 w-9 rounded-full bg-black/55 text-red-400 hover:bg-red-500/70 hover:text-white"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>

          <div className="flex gap-2">
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
      </div>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Löschen bestätigen</AlertDialogTitle>
            <AlertDialogDescription>
              Möchtest du dieses Element wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
            >
              Löschen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
