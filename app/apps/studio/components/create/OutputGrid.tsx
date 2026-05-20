'use client';

import type { ReactNode } from 'react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { OutputErrorCard } from './OutputErrorCard';
import { OutputProcessingSkeleton } from './OutputProcessingSkeleton';
import { OutputThumbnail } from './OutputThumbnail';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export type OutputMediaFilter = 'all' | 'image' | 'video' | 'favorites' | 'generating' | 'failed';
export type OutputDateFilter = 'all' | 'today' | 'yesterday' | 'last7' | 'last30' | 'older';
export type OutputSortOrder = 'newest' | 'oldest';

interface OutputGridProps {
  generations: StudioGeneration[];
  initialLoading?: boolean;
  recentlyCompletedIds?: Set<string>;
  emptyState: ReactNode;
  mediaFilter?: OutputMediaFilter;
  dateFilter?: OutputDateFilter;
  sortOrder?: OutputSortOrder;
  selectionEnabled?: boolean;
  selectedOutputIds?: string[];
  hasMoreGenerations?: boolean;
  loadingMoreGenerations?: boolean;
  onToggleSelectOutput?: (outputId: string, selected: boolean) => void;
  onLoadMoreGenerations?: () => void;
  onOutputOpen: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDeleteGeneration?: (generation: StudioGeneration) => void;
  onSaveToWorkspace?: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

export function OutputGrid({
  generations,
  initialLoading = false,
  recentlyCompletedIds,
  emptyState,
  mediaFilter = 'all',
  dateFilter = 'all',
  sortOrder = 'newest',
  selectionEnabled = false,
  selectedOutputIds = [],
  hasMoreGenerations = false,
  loadingMoreGenerations = false,
  onToggleSelectOutput,
  onLoadMoreGenerations,
  onOutputOpen,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
  onDelete,
  onDeleteGeneration,
  onSaveToWorkspace,
}: OutputGridProps) {
  const getExpectedOutputCount = (generation: StudioGeneration) => {
    if (generation.mode === 'video') {
      return 1;
    }

    try {
      const parsed = generation.metadata ? JSON.parse(generation.metadata) : null;
      const count = typeof parsed?.expectedCount === 'number' ? parsed.expectedCount : 1;
      return Math.max(1, Math.min(count, 4));
    } catch {
      return 1;
    }
  };

  const getGenerationError = (generation: StudioGeneration) => {
    try {
      const parsed = generation.metadata ? JSON.parse(generation.metadata) : null;
      return typeof parsed?.error === 'string' ? parsed.error : generation.metadata || null;
    } catch {
      return generation.metadata || null;
    }
  };

  const pendingGenerations = generations.filter(
    (generation) =>
      (generation.status === 'pending' || generation.status === 'generating') &&
      generation.outputs.length === 0,
  );

  const failedGenerations = generations.filter(
    (generation) =>
      generation.status === 'failed' &&
      generation.outputs.length === 0,
  );

  const outputs = generations.flatMap((generation) =>
    generation.outputs.map((output) => ({
      generation,
      ...output,
      generationId: generation.id,
      generationStatus: generation.status,
      generationMode: generation.mode,
      createdAt: generation.createdAt,
    })),
  );

  if (initialLoading && outputs.length === 0 && pendingGenerations.length === 0 && failedGenerations.length === 0) {
    return (
      <div className="flex min-h-[520px] flex-col justify-center px-3 py-8">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-5">
          <div className="flex items-center justify-between px-1">
            <div className="space-y-2">
              <div className="h-2 w-12 animate-pulse rounded-full bg-primary/60" />
              <p className="text-sm font-semibold text-foreground">Loading images...</p>
            </div>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {Array.from({ length: 12 }, (_, index) => (
              <div
                key={index}
                className="aspect-square overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm"
              >
                <Skeleton className="h-full w-full rounded-none bg-muted/80" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (outputs.length === 0 && pendingGenerations.length === 0 && failedGenerations.length === 0) {
    return <>{emptyState}</>;
  }

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfLast7 = startOfToday - 6 * 24 * 60 * 60 * 1000;
  const startOfLast30 = startOfToday - 29 * 24 * 60 * 60 * 1000;

  const getDateBucket = (value: string) => {
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return 'older';
    if (time >= startOfToday) return 'today';
    if (time >= startOfYesterday) return 'yesterday';
    if (time >= startOfLast7) return 'last7';
    if (time >= startOfLast30) return 'last30';
    return 'older';
  };

  const matchesDateFilter = (value: string) => {
    if (dateFilter === 'all') return true;
    const time = new Date(value).getTime();
    if (Number.isNaN(time)) return dateFilter === 'older';
    if (dateFilter === 'today') return time >= startOfToday;
    if (dateFilter === 'yesterday') return time >= startOfYesterday && time < startOfToday;
    if (dateFilter === 'last7') return time >= startOfLast7;
    if (dateFilter === 'last30') return time >= startOfLast30;
    return time < startOfLast30;
  };

  const visiblePendingGenerations = pendingGenerations
    .filter(() => mediaFilter === 'all' || mediaFilter === 'generating')
    .filter((generation) => matchesDateFilter(generation.createdAt))
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      return sortOrder === 'newest' ? right - left : left - right;
    });

  const visibleFailedGenerations = failedGenerations
    .filter(() => mediaFilter === 'all' || mediaFilter === 'failed')
    .filter((generation) => matchesDateFilter(generation.createdAt))
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      return sortOrder === 'newest' ? right - left : left - right;
    });

  const visibleOutputs = outputs
    .filter((output) => {
      if (mediaFilter === 'all') return true;
      if (mediaFilter === 'favorites') return output.isFavorite;
      if (mediaFilter === 'image' || mediaFilter === 'video') return output.type === mediaFilter;
      return false;
    })
    .filter((output) => matchesDateFilter(output.createdAt))
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      return sortOrder === 'newest' ? right - left : left - right;
    });

  const bucketLabels: Record<OutputDateFilter, string> = {
    all: 'All dates',
    today: 'Today',
    yesterday: 'Yesterday',
    last7: 'Last 7 days',
    last30: 'Last 30 days',
    older: 'Older',
  };
  const bucketOrder: OutputDateFilter[] = sortOrder === 'newest'
    ? ['today', 'yesterday', 'last7', 'last30', 'older']
    : ['older', 'last30', 'last7', 'yesterday', 'today'];

  const outputSections = bucketOrder
    .map((bucket) => ({
      bucket,
      label: bucketLabels[bucket],
      outputs: visibleOutputs.filter((output) => getDateBucket(output.createdAt) === bucket),
    }))
    .filter((section) => section.outputs.length > 0);

  if (visibleOutputs.length === 0 && visiblePendingGenerations.length === 0 && visibleFailedGenerations.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center px-6 py-12 text-center text-sm text-muted-foreground">
        No generations match these filters.
      </div>
    );
  }

  return (
    <div className="space-y-6 p-3">
      {visiblePendingGenerations.length > 0 || visibleFailedGenerations.length > 0 ? (
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-foreground">In progress</h2>
            <span className="text-xs text-muted-foreground">
              {visiblePendingGenerations.length + visibleFailedGenerations.length} active
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {visiblePendingGenerations.flatMap((generation) =>
              Array.from({ length: getExpectedOutputCount(generation) }, (_, index) => (
                <OutputProcessingSkeleton key={`${generation.id}-${index}`} mode={generation.mode} prompt={generation.prompt} />
              )),
            )}

            {visibleFailedGenerations.map((generation) => (
              <OutputErrorCard
                key={generation.id}
                mode={generation.mode}
                message={getGenerationError(generation)}
                onDelete={() => onDeleteGeneration?.(generation)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {outputSections.map((section) => (
        <section key={section.bucket} className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold text-foreground">{section.label}</h2>
            <span className="text-xs text-muted-foreground">
              {section.outputs.length} output{section.outputs.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
            {section.outputs.map((output) => (
              <OutputThumbnail
                key={output.id}
                id={output.id}
                mediaUrl={output.mediaUrl}
                filePath={output.filePath}
                type={output.type}
                generationMode={output.generationMode}
                generation={output.generation}
                output={output}
                selected={selectedOutputIds?.includes(output.id)}
                selectionMode={selectionEnabled}
                onSelectToggle={onToggleSelectOutput}
                title={output.type === 'video' ? 'Video output' : 'Image output'}
                recentlyCompleted={recentlyCompletedIds?.has(output.generationId) ?? false}
                onOpen={() => onOutputOpen({ generation: output.generation, output })}
                onToggleFavorite={onToggleFavorite}
                onCreateVariation={onCreateVariation}
                onCreateVideo={onCreateVideo}
                onDelete={onDelete}
                onSaveToWorkspace={onSaveToWorkspace}
              />
            ))}
          </div>
        </section>
      ))}

      {hasMoreGenerations ? (
        <div className="flex justify-center py-4">
          <Button
            type="button"
            variant="outline"
            onClick={onLoadMoreGenerations}
            disabled={loadingMoreGenerations}
          >
            {loadingMoreGenerations ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
