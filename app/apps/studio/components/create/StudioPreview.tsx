'use client';

/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, AudioLines, Brush, Check, ChevronDown, ChevronLeft, ChevronRight, Download, Film, ImageIcon, Info, Maximize2, MoreHorizontal, RefreshCcw, Save, Star, Trash2, User, Box } from 'lucide-react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import type { StudioProduct, StudioPersona, StudioStyle } from '../../types/models';
import type { StudioPreset } from '../../types/presets';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { downloadStudioOutput } from '../../utils/downloadStudioOutput';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MarkdownRenderer } from '@/app/components/shared/MarkdownRenderer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

interface VisibleOutputEntry {
  generation: StudioGeneration;
  output: StudioGenerationOutput;
}

interface StudioPreviewProps {
  generation: StudioGeneration | null;
  output: StudioGenerationOutput | null;
  products: StudioProduct[];
  personas: StudioPersona[];
  styles: StudioStyle[];
  presets: StudioPreset[];
  open: boolean;
  allVisibleOutputs: VisibleOutputEntry[];
  onClose: () => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onEditSelection?: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onUseAspectRatio?: (generation: StudioGeneration, output: StudioGenerationOutput, aspectRatio: string) => void;
  onOpenCustomAspectRatio?: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onSaveToWorkspace?: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onNavigate?: (generationId: string, outputId: string) => void;
}

function getAspectRatioLabel(output: StudioGenerationOutput, generation: StudioGeneration) {
  if (output.width && output.height) {
    return `${output.width}:${output.height}`;
  }

  return generation.aspectRatio;
}

function AspectRatioGlyph({ ratio }: { ratio: string }) {
  const shape: Record<string, string> = {
    '1:1': 'h-3.5 w-3.5',
    '3:4': 'h-4 w-3',
    '9:16': 'h-5 w-2.5',
    '4:3': 'h-3 w-4',
    '16:9': 'h-2.5 w-5',
  };

  return <span className={`inline-block rounded-[2px] border border-current ${shape[ratio] ?? 'h-3.5 w-3.5'}`} />;
}

const DETAIL_ASPECT_RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const;

export function StudioPreview({
  generation,
  output,
  products,
  personas,
  styles,
  presets,
  open,
  allVisibleOutputs,
  onClose,
  onToggleFavorite,
  onEditSelection,
  onUseAspectRatio,
  onOpenCustomAspectRatio,
  onCreateVariation,
  onCreateVideo,
  onDelete,
  onSaveToWorkspace,
  onNavigate,
}: StudioPreviewProps) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false);

  const currentIndex = allVisibleOutputs.findIndex(
    (entry) => entry.generation.id === generation?.id && entry.output.id === output?.id,
  );
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < allVisibleOutputs.length - 1;

  const navigateToIndex = useCallback(
    (index: number) => {
      const entry = allVisibleOutputs[index];
      if (entry && onNavigate) {
        onNavigate(entry.generation.id, entry.output.id);
      }
    },
    [allVisibleOutputs, onNavigate],
  );

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
      if (event.key === 'ArrowLeft' && hasPrev) {
        event.preventDefault();
        navigateToIndex(currentIndex - 1);
      }
      if (event.key === 'ArrowRight' && hasNext) {
        event.preventDefault();
        navigateToIndex(currentIndex + 1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleClose, open, hasPrev, hasNext, currentIndex, navigateToIndex]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setMobileDetailsOpen(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, output?.id]);

  if (!open || !generation || !output) {
    return null;
  }

  const handleDownload = () => {
    if (!output.mediaUrl) return;
    void downloadStudioOutput(output.id);
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
  const canEditImage = output.type === 'image' && Boolean(output.mediaUrl) && Boolean(onEditSelection);
  const canUseAspectRatio = output.type === 'image' && Boolean(output.mediaUrl) && Boolean(onUseAspectRatio);
  const canOpenCustomAspectRatio = output.type === 'image' && Boolean(output.filePath) && Boolean(onOpenCustomAspectRatio);

  return (
    <section
      aria-label="Studio output preview"
      className="absolute inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-background"
    >
      <div className="flex min-h-16 items-center justify-between gap-3 border-b border-border/70 px-3 py-2 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          <Button variant="ghost" size="icon" className="shrink-0 rounded-full" onClick={handleClose} aria-label="Zurück zum Grid">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <div className="min-w-0 truncate text-sm font-semibold text-foreground sm:text-base [&_p]:my-0 [&_p]:inline">
              <MarkdownRenderer content={prompt} variant="default" />
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="capitalize">{output.type}</span>
              {output.type !== 'sound' ? <span>AR {aspectRatioLabel}</span> : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="icon"
            className="rounded-full sm:hidden"
            onClick={() => onEditSelection?.(generation, output)}
            disabled={!canEditImage}
            aria-label="Edit selection"
          >
            <Brush className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hidden gap-2 rounded-full sm:inline-flex"
            onClick={() => onEditSelection?.(generation, output)}
            disabled={!canEditImage}
          >
            <Brush className="h-4 w-4" />
            Edit
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="rounded-full sm:hidden" disabled={!canUseAspectRatio} aria-label="Aspect ratio">
                <Maximize2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-2">
              <div className="px-2 pb-2 pt-1 text-sm leading-5 text-muted-foreground">
                Generate this image with a different aspect ratio
              </div>
              {DETAIL_ASPECT_RATIOS.map((ratio) => (
                <DropdownMenuItem
                  key={`mobile-direct-ar-${ratio}`}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-base"
                  onSelect={() => onUseAspectRatio?.(generation, output, ratio)}
                >
                  <AspectRatioGlyph ratio={ratio} />
                  <span className="flex-1">
                    {ratio === '1:1' ? 'Square' : ratio === '3:4' ? 'Portrait' : ratio === '9:16' ? 'Story' : ratio === '4:3' ? 'Landscape' : 'Widescreen'}
                    <span className="ml-2 text-muted-foreground">{ratio}</span>
                  </span>
                  {generation.aspectRatio === ratio && <Check className="h-4 w-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-base"
                onSelect={() => onOpenCustomAspectRatio?.(generation, output)}
                disabled={!canOpenCustomAspectRatio}
              >
                <Maximize2 className="h-4 w-4" />
                <span className="flex-1">Custom aspect ratio</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="hidden gap-2 rounded-full sm:inline-flex" disabled={!canUseAspectRatio}>
                <Maximize2 className="h-4 w-4" />
                Aspect ratio
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72 p-2">
              <div className="px-2 pb-2 pt-1 text-sm leading-5 text-muted-foreground">
                Generate this image with a different aspect ratio
              </div>
              {DETAIL_ASPECT_RATIOS.map((ratio) => (
                <DropdownMenuItem
                  key={ratio}
                  className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-base"
                  onSelect={() => onUseAspectRatio?.(generation, output, ratio)}
                >
                  <AspectRatioGlyph ratio={ratio} />
                  <span className="flex-1">
                    {ratio === '1:1' ? 'Square' : ratio === '3:4' ? 'Portrait' : ratio === '9:16' ? 'Story' : ratio === '4:3' ? 'Landscape' : 'Widescreen'}
                    <span className="ml-2 text-muted-foreground">{ratio}</span>
                  </span>
                  {generation.aspectRatio === ratio && <Check className="h-4 w-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-base"
                onSelect={() => onOpenCustomAspectRatio?.(generation, output)}
                disabled={!canOpenCustomAspectRatio}
              >
                <Maximize2 className="h-4 w-4" />
                <span className="flex-1">Custom aspect ratio</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Button variant="outline" size="sm" className="hidden gap-2 rounded-full md:inline-flex" onClick={() => onCreateVariation(generation, output)} disabled={output.type !== 'image'}>
            <RefreshCcw className="h-4 w-4" />
            Remix
          </Button>
          <Button variant="outline" size="icon" className="rounded-full" onClick={handleDownload} disabled={!output.mediaUrl} aria-label="Download">
            <Download className="h-4 w-4" />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="rounded-full" aria-label="More actions">
                <MoreHorizontal className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onSelect={() => onEditSelection?.(generation, output)} disabled={!canEditImage}>
                <Brush className="mr-2 h-4 w-4" />
                Edit selection
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {DETAIL_ASPECT_RATIOS.map((ratio) => (
                <DropdownMenuItem
                  key={`mobile-ar-${ratio}`}
                  onSelect={() => onUseAspectRatio?.(generation, output, ratio)}
                  disabled={!canUseAspectRatio}
                >
                  <AspectRatioGlyph ratio={ratio} />
                  <span className="ml-2">Make AR {ratio}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem onSelect={() => onOpenCustomAspectRatio?.(generation, output)} disabled={!canOpenCustomAspectRatio}>
                <Maximize2 className="mr-2 h-4 w-4" />
                Custom aspect ratio
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onCreateVariation(generation, output)} disabled={output.type !== 'image'}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Remix
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onCreateVideo(generation, output)} disabled={output.type !== 'image'}>
                <Film className="mr-2 h-4 w-4" />
                Create video
              </DropdownMenuItem>
              {onSaveToWorkspace && (
                <DropdownMenuItem onSelect={() => onSaveToWorkspace(generation, output)}>
                  <Save className="mr-2 h-4 w-4" />
                  Save to Workspace
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onToggleFavorite(generation, output)}>
                <Star className={`mr-2 h-4 w-4 ${output.isFavorite ? 'fill-current text-amber-500' : ''}`} />
                Favorite
              </DropdownMenuItem>
              <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => setShowDeleteDialog(true)}>
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(125,167,255,0.10),_transparent_28%),radial-gradient(circle_at_bottom_right,_rgba(255,166,107,0.10),_transparent_32%)]">
        <div className="relative flex min-h-0 flex-1 items-center justify-center px-2 py-2 sm:px-6 sm:py-6">
          {hasPrev && (
            <button
              type="button"
              className="absolute left-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60 sm:left-4 sm:h-12 sm:w-12"
              onClick={() => navigateToIndex(currentIndex - 1)}
              aria-label="Vorheriges Bild"
            >
              <ChevronLeft className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
          )}

          <div className="flex h-full w-full min-w-0 items-center justify-center overflow-hidden bg-background/35 p-1 shadow-sm sm:p-3">
            {output.mediaUrl ? (
              output.type === 'sound' ? (
                <div className="flex min-h-[40vh] w-full max-w-2xl flex-col items-center justify-center gap-6 rounded-3xl border border-border/70 bg-card/85 p-6 shadow-2xl">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full border border-border/70 bg-background text-primary">
                    <AudioLines className="h-10 w-10" />
                  </div>
                  <audio className="w-full" src={output.mediaUrl} controls preload="metadata" />
                  <div className="flex w-full max-w-sm items-end justify-center gap-1.5">
                    {[36, 58, 44, 76, 52, 66, 40, 60, 34].map((height, index) => (
                      <span key={index} className="w-3 rounded-full bg-primary/70" style={{ height }} />
                    ))}
                  </div>
                </div>
              ) : output.type === 'video' ? (
                <video
                  className="max-h-full max-w-full object-contain shadow-2xl"
                  src={output.mediaUrl}
                  controls
                  playsInline
                  preload="metadata"
                />
              ) : (
                <img
                  className="max-h-full max-w-full object-contain shadow-2xl"
                  src={output.mediaUrl}
                  alt={output.filePath}
                />
              )
            ) : (
              <div className="flex min-h-[40vh] sm:min-h-[320px] w-full items-center justify-center rounded-2xl bg-muted text-muted-foreground">
                {output.type === 'sound' ? <AudioLines className="h-10 w-10" /> : <ImageIcon className="h-10 w-10" />}
              </div>
            )}
          </div>

          {hasNext && (
            <button
              type="button"
              className="absolute right-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm transition hover:bg-black/60 sm:right-4 sm:h-12 sm:w-12"
              onClick={() => navigateToIndex(currentIndex + 1)}
              aria-label="Nächstes Bild"
            >
              <ChevronRight className="h-5 w-5 sm:h-6 sm:w-6" />
            </button>
          )}
        </div>

        {allVisibleOutputs.length > 1 && currentIndex >= 0 && (
          <div className="flex items-center justify-center py-1 text-xs font-medium text-muted-foreground">
            {currentIndex + 1} / {allVisibleOutputs.length}
          </div>
        )}

        <div className="flex-shrink-0 overflow-hidden border-t border-border/70 bg-background/94 backdrop-blur">
          <button
            type="button"
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium sm:hidden"
            onClick={() => setMobileDetailsOpen((current) => !current)}
            aria-expanded={mobileDetailsOpen}
          >
            <span className="inline-flex items-center gap-2">
              <Info className="h-4 w-4" />
              Details
            </span>
            <ChevronDown className={cn('h-4 w-4 transition-transform', mobileDetailsOpen && 'rotate-180')} />
          </button>
          <div
            className={cn(
              'overflow-y-auto px-4 pb-4 sm:px-6 sm:py-4',
              mobileDetailsOpen ? 'max-h-[34dvh]' : 'hidden sm:block sm:max-h-[42vh]',
            )}
          >
              <div className="mx-auto max-w-6xl space-y-4">
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
                  {output.type !== 'sound' ? (
                    <Badge variant="outline" className="rounded-full px-3 py-1">
                      AR {aspectRatioLabel}
                    </Badge>
                  ) : null}
                  <Badge variant="outline" className="rounded-full px-3 py-1">
                    {generation.mode}
                  </Badge>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Prompt</p>
                  <div className="max-w-4xl">
                    <MarkdownRenderer content={prompt} variant="default" className="[&_p]:leading-6" />
                  </div>
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
      </div>
    </section>
  );
}
