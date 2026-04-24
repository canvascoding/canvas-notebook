'use client';

import type { ReactNode } from 'react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { OutputErrorCard } from './OutputErrorCard';
import { OutputProcessingSkeleton } from './OutputProcessingSkeleton';
import { OutputThumbnail } from './OutputThumbnail';

export type OutputMediaFilter = 'all' | 'image' | 'video' | 'favorites' | 'generating' | 'failed';
export type OutputDateFilter = 'all' | 'today' | 'yesterday' | 'last7' | 'last30' | 'older';
export type OutputSortOrder = 'newest' | 'oldest';

interface OutputGridProps {
  generations: StudioGeneration[];
  emptyState: ReactNode;
  mediaFilter?: OutputMediaFilter;
  dateFilter?: OutputDateFilter;
  sortOrder?: OutputSortOrder;
  selectionEnabled?: boolean;
  selectedOutputIds?: string[];
  onToggleSelectOutput?: (outputId: string, selected: boolean) => void;
  onOutputOpen: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onSaveToWorkspace?: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

export function OutputGrid({
  generations,
  emptyState,
  mediaFilter = 'all',
  dateFilter = 'all',
  sortOrder = 'newest',
  selectionEnabled = false,
  selectedOutputIds = [],
  onToggleSelectOutput,
  onOutputOpen,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
  onDelete,
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
    return getDateBucket(value) === dateFilter;
  };

  const visiblePendingGenerations = pendingGenerations
    .filter((generation) => mediaFilter === 'all' || mediaFilter === 'generating')
    .filter((generation) => matchesDateFilter(generation.createdAt))
    .sort((a, b) => {
      const left = new Date(a.createdAt).getTime();
      const right = new Date(b.createdAt).getTime();
      return sortOrder === 'newest' ? right - left : left - right;
    });

  const visibleFailedGenerations = failedGenerations
    .filter((generation) => mediaFilter === 'all' || mediaFilter === 'failed')
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
    .filter((output) => matchesDateFilter(output.createdAt || output.createdAt))
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
                <OutputProcessingSkeleton key={`${generation.id}-${index}`} mode={generation.mode} />
              )),
            )}

            {visibleFailedGenerations.map((generation) => (
              <OutputErrorCard
                key={generation.id}
                mode={generation.mode}
                message={getGenerationError(generation)}
                onDelete={() => onDelete(generation, generation.outputs[0] ?? { id: `${generation.id}-error`, generationId: generation.id, variationIndex: 0, type: 'image', filePath: '', mediaUrl: null, fileSize: null, mimeType: null, width: null, height: null, isFavorite: false, createdAt: generation.createdAt })}
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
    </div>
  );
}
