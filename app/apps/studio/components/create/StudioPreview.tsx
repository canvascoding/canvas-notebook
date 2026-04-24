'use client';

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Download, Film, ImageIcon, RefreshCcw, Star, Trash2, User, Box } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import type { StudioProduct, StudioPersona, StudioStyle } from '../../types/models';
import type { StudioPreset } from '../../types/presets';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { Badge } from '@/components/ui/badge';
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

interface StudioPreviewProps {
  generation: StudioGeneration | null;
  output: StudioGenerationOutput | null;
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  presets: StudioPreset[];
  open: boolean;
  onClose: () => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

function getAspectRatioLabel(output: StudioGenerationOutput, generation: StudioGeneration) {
  if (output.width && output.height) {
    return `${output.width}:${output.height}`;
  }

  return generation.aspectRatio;
}

export function StudioPreview({
  generation,
  output,
  products,
  personas,
  styles,
  presets,
  open,
  onClose,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
  onDelete,
}: StudioPreviewProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleClose = useCallback(() => {
    if (typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, open]);

  if (!open || !generation || !output) {
    return null;
  }

  const handleDownload = () => {
    if (!output.mediaUrl) return;
    window.open(output.mediaUrl, '_blank', 'noopener,noreferrer');
  };

  const handleDelete = () => {
    setShowDeleteDialog(false);
    if (generation && output) {
      onDelete(generation, output);
      handleClose();
    }
  };

  const resolvedProducts = (generation.product_ids ?? []).map((id) => {
    const found = products.find((p) => p.id === id);
    return found 
      ? { type: 'product' as const, id, name: found.name, thumbnailPath: found.thumbnailPath } 
      : { type: 'orphaned-product' as const, id, name: '[Gelöscht]' };
  });

  const resolvedPersonas = (generation.persona_ids ?? []).map((id) => {
    const found = personas.find((p) => p.id === id);
    return found 
      ? { type: 'persona' as const, id, name: found.name, thumbnailPath: found.thumbnailPath } 
      : { type: 'orphaned-persona' as const, id, name: '[Gelöscht]' };
  });

  const resolvedStyles = (generation.style_ids ?? []).map((id) => {
    const found = styles.find((s) => s.id === id);
    return found 
      ? { type: 'style' as const, id, name: found.name, thumbnailPath: found.thumbnailPath } 
      : { type: 'orphaned-style' as const, id, name: '[Gelöscht]' };
  });

  const resolvedPreset = generation.studioPresetId
    ? presets.find((p) => p.id === generation.studioPresetId)
    : null;

  const hasAnyReferences = resolvedProducts.length > 0 || resolvedPersonas.length > 0 || resolvedStyles.length > 0;

  const aspectRatioLabel = getAspectRatioLabel(output, generation);
  const prompt = generation.prompt || generation.rawPrompt || 'No prompt saved for this generation.';

  return (
    <section
      aria-label="Studio output preview"
      className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="flex items-center justify-between border-b border-border/70 px-4 py-3 sm:px-6">
        <Button variant="ghost" size="sm" className="gap-2 rounded-full" onClick={handleClose}>
          <ArrowLeft className="h-4 w-4" />
          Zurück zum Grid
        </Button>
        <Badge variant="outline" className="rounded-full px-3 py-1 uppercase tracking-[0.18em]">
          {output.type}
        </Badge>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.10),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.10),_transparent_32%)]">
        <div className="flex min-h-0 flex-col">
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
                  {resolvedPreset ? (
                    <Badge variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                      {resolvedPreset.previewImagePath ? (
                        <img
                          src={toPreviewUrl(resolvedPreset.previewImagePath, 64, { preset: 'mini' })}
                          alt=""
                          className="h-4 w-4 rounded-sm object-cover shrink-0"
                        />
                      ) : null}
                      {resolvedPreset.name}
                    </Badge>
                  ) : generation.studioPresetId ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
                      [Gelöscht]
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
                      No preset
                    </span>
                  )}
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

                {hasAnyReferences && (
                  <div className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Referenzen</p>
                    <div className="flex flex-wrap gap-2">
                      {resolvedProducts.map((item) =>
                        item.type === 'product' ? (
                          <Badge key={`product-${item.id}`} variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                            {item.thumbnailPath ? (
                              <img
                                src={toPreviewUrl(item.thumbnailPath, 64, { preset: 'mini' })}
                                alt=""
                                className="h-4 w-4 rounded-sm object-cover shrink-0"
                              />
                            ) : (
                              <Box className="h-3 w-3" />
                            )}
                            {item.name}
                          </Badge>
                        ) : (
                          <span
                            key={`orphaned-product-${item.id}`}
                            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
                          >
                            <Box className="h-3 w-3" />
                            {item.name}
                          </span>
                        )
                      )}
                      {resolvedPersonas.map((item) =>
                        item.type === 'persona' ? (
                          <Badge key={`persona-${item.id}`} variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                            {item.thumbnailPath ? (
                              <img
                                src={toPreviewUrl(item.thumbnailPath, 64, { preset: 'mini' })}
                                alt=""
                                className="h-4 w-4 rounded-sm object-cover shrink-0"
                              />
                            ) : (
                              <User className="h-3 w-3" />
                            )}
                            {item.name}
                          </Badge>
                        ) : (
                          <span
                            key={`orphaned-persona-${item.id}`}
                            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
                          >
                            <User className="h-3 w-3" />
                            {item.name}
                          </span>
                        )
                      )}
                      {resolvedStyles.map((item) =>
                        item.type === 'style' ? (
                          <Badge key={`style-${item.id}`} variant="secondary" className="gap-1.5 rounded-full px-3 py-1">
                            {item.thumbnailPath ? (
                              <img
                                src={toPreviewUrl(item.thumbnailPath, 64, { preset: 'mini' })}
                                alt=""
                                className="h-4 w-4 rounded-sm object-cover shrink-0"
                              />
                            ) : (
                              <span className="h-3 w-3 text-xs">🎨</span>
                            )}
                            {item.name}
                          </Badge>
                        ) : (
                          <span
                            key={`orphaned-style-${item.id}`}
                            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-muted-foreground/40 bg-muted/50 px-3 py-1 text-xs text-muted-foreground"
                          >
                            <span className="h-3 w-3 text-xs">🎨</span>
                            {item.name}
                          </span>
                        )
                      )}
                    </div>
                  </div>
                )}

                {/* Generation Metadata */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Generation Details</p>
                  <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                      <span className="font-medium text-foreground">Provider:</span> {generation.provider}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                      <span className="font-medium text-foreground">Model:</span> {generation.model}
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                      <span className="font-medium text-foreground">Variations:</span> {generation.outputs?.length || 1}
                    </span>
                    {output.fileSize && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                        <span className="font-medium text-foreground">Size:</span> {Math.round(output.fileSize / 1024)}KB
                      </span>
                    )}
                    {output.metadata && (() => {
                      try {
                        const meta = JSON.parse(output.metadata);
                        return (
                          <>
                            {meta.quality && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                                <span className="font-medium text-foreground">Quality:</span> {meta.quality}
                              </span>
                            )}
                            {meta.outputFormat && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                                <span className="font-medium text-foreground">Format:</span> {meta.outputFormat}
                              </span>
                            )}
                            {meta.background && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                                <span className="font-medium text-foreground">Background:</span> {meta.background}
                              </span>
                            )}
                            {meta.usage && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-muted/30 px-2.5 py-1">
                                <span className="font-medium text-foreground">Tokens:</span> {meta.usage.totalTokens} ({meta.usage.inputTokens} in / {meta.usage.outputTokens} out)
                              </span>
                            )}
                          </>
                        );
                      } catch {
                        return null;
                      }
                    })()}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" className="gap-2 rounded-full" onClick={handleDownload} disabled={!output.mediaUrl}>
                    <Download className="h-4 w-4" />
                    Download
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-full" onClick={() => onToggleFavorite(generation, output)}>
                    <Star className={`h-4 w-4 ${output.isFavorite ? 'fill-current text-amber-500' : ''}`} />
                    Favorit
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-full" onClick={() => onCreateVariation(generation, output)}>
                    <RefreshCcw className="h-4 w-4" />
                    Remix
                  </Button>
                  <Button variant="outline" className="gap-2 rounded-full" onClick={() => onCreateVideo(generation, output)} disabled={output.type !== 'image'}>
                    <Film className="h-4 w-4" />
                    Video
                  </Button>
                  <Button
                    variant="outline"
                    className="gap-2 rounded-full text-red-600 hover:bg-red-500/10 hover:text-red-700"
                    onClick={() => setShowDeleteDialog(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    Löschen
                  </Button>
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
              </div>
            </div>
      </div>
    </section>
  );
}
