'use client';

/* eslint-disable @next/next/no-img-element */

import { useEffect } from 'react';
import { ArrowLeft, Download, Film, ImageIcon, RefreshCcw, Trash2 } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { OutputDetailChat } from './OutputDetailChat';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

interface OutputDetailViewProps {
  generation: StudioGeneration | null;
  output: StudioGenerationOutput | null;
  generations: StudioGeneration[];
  open: boolean;
  onClose: () => void;
  onSelectOutput: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => void;
}

function getAspectRatioLabel(output: StudioGenerationOutput, generation: StudioGeneration) {
  if (output.width && output.height) {
    return `${output.width}:${output.height}`;
  }

  return generation.aspectRatio;
}

export function OutputDetailView({ generation, output, generations, open, onClose, onSelectOutput }: OutputDetailViewProps) {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!generation || !output) {
    return null;
  }

  const handleDownload = () => {
    if (!output.mediaUrl) return;
    window.open(output.mediaUrl, '_blank', 'noopener,noreferrer');
  };

  const presetName = generation.studioPreset?.name || 'No preset';
  const aspectRatioLabel = getAspectRatioLabel(output, generation);
  const prompt = generation.prompt || generation.rawPrompt || 'No prompt saved for this generation.';

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent layout="viewport" showCloseButton={false} className="overflow-hidden bg-background p-0">
        <DialogTitle className="sr-only">Studio output detail</DialogTitle>
        <DialogDescription className="sr-only">
          Review the selected studio output, metadata, and chat workspace.
        </DialogDescription>

        <div className="flex h-full min-h-0 flex-col">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 sm:px-6">
            <Button variant="ghost" size="sm" className="gap-2 rounded-full" onClick={onClose}>
              <ArrowLeft className="h-4 w-4" />
              Zurueck zum Grid
            </Button>
            <Badge variant="outline" className="rounded-full px-3 py-1 uppercase tracking-[0.18em]">
              {output.type}
            </Badge>
          </div>

          <div className="grid min-h-0 flex-1 bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.10),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.10),_transparent_32%)] lg:grid-cols-[minmax(0,1fr)_420px] xl:grid-cols-[minmax(0,1fr)_460px]">
            <div className="flex min-h-0 flex-col border-b border-border/70 lg:border-r lg:border-b-0">
              <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-4 sm:px-6 sm:py-6">
                <div className="flex h-full max-h-full w-full items-center justify-center overflow-hidden rounded-[28px] border border-border/60 bg-card/70 p-3 shadow-sm">
                  {output.mediaUrl ? (
                    output.type === 'video' ? (
                      <video
                        className="max-h-full max-w-full rounded-2xl object-contain"
                        src={output.mediaUrl}
                        controls
                        playsInline
                      />
                    ) : (
                      <img
                        className="max-h-full max-w-full rounded-2xl object-contain"
                        src={output.mediaUrl}
                        alt={output.filePath}
                      />
                    )
                  ) : (
                    <div className="flex h-full min-h-[320px] w-full items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                      <ImageIcon className="h-10 w-10" />
                    </div>
                  )}
                </div>
              </div>

              <div className="space-y-4 border-t border-border/70 bg-background/92 px-4 py-4 backdrop-blur sm:px-6">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary" className="rounded-full px-3 py-1">
                    {presetName}
                  </Badge>
                  <Badge variant="outline" className="rounded-full px-3 py-1">
                    AR {aspectRatioLabel}
                  </Badge>
                  <Badge variant="outline" className="rounded-full px-3 py-1">
                    {generation.mode}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prompt</p>
                  <p className="max-w-4xl text-sm leading-6 text-foreground">{prompt}</p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="gap-2 rounded-full" onClick={handleDownload} disabled={!output.mediaUrl}>
                    <Download className="h-4 w-4" />
                    Download
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-full" disabled>
                    <RefreshCcw className="h-4 w-4" />
                    Remix
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-full" disabled>
                    <Trash2 className="h-4 w-4" />
                    Loeschen
                  </Button>
                </div>
              </div>
            </div>

            <aside className="flex min-h-0 flex-col bg-card/55">
              <OutputDetailChat
                generation={generation}
                output={output}
                generations={generations}
                onSelectOutput={onSelectOutput}
              />
            </aside>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
