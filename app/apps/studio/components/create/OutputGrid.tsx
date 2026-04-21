'use client';

import type { ReactNode } from 'react';
import type { StudioGeneration, StudioGenerationOutput } from '../../types/generation';
import { OutputErrorCard } from './OutputErrorCard';
import { OutputProcessingSkeleton } from './OutputProcessingSkeleton';
import { OutputThumbnail } from './OutputThumbnail';

interface OutputGridProps {
  generations: StudioGeneration[];
  emptyState: ReactNode;
  onOutputOpen: (selection: { generation: StudioGeneration; output: StudioGenerationOutput }) => void;
  onToggleFavorite: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onCreateVideo: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
  onDelete: (generation: StudioGeneration, output: StudioGenerationOutput) => void;
}

export function OutputGrid({
  generations,
  emptyState,
  onOutputOpen,
  onToggleFavorite,
  onCreateVariation,
  onCreateVideo,
  onDelete,
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

  return (
    <div className="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
      {pendingGenerations.flatMap((generation) =>
        Array.from({ length: getExpectedOutputCount(generation) }, (_, index) => (
          <OutputProcessingSkeleton key={`${generation.id}-${index}`} mode={generation.mode} />
        )),
      )}

      {failedGenerations.map((generation) => (
        <OutputErrorCard
          key={generation.id}
          mode={generation.mode}
          message={getGenerationError(generation)}
          onDelete={() => onDelete(generation, generation.outputs[0] ?? { id: `${generation.id}-error`, type: 'image', filePath: '', isFavorite: false, createdAt: generation.createdAt })}
        />
      ))}

      {outputs.map((output) => (
        <OutputThumbnail
          key={output.id}
          id={output.id}
          mediaUrl={output.mediaUrl}
          filePath={output.filePath}
          type={output.type}
          generationMode={output.generationMode}
          generation={output.generation}
          output={output}
          title={output.type === 'video' ? 'Video output' : 'Image output'}
          onOpen={() => onOutputOpen({ generation: output.generation, output })}
          onToggleFavorite={onToggleFavorite}
          onCreateVariation={onCreateVariation}
          onCreateVideo={onCreateVideo}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
