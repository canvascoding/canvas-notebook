'use client';

import type { ReactNode } from 'react';
import type { StudioGeneration } from '../../types/generation';
import { OutputErrorCard } from './OutputErrorCard';
import { OutputProcessingSkeleton } from './OutputProcessingSkeleton';
import { OutputThumbnail } from './OutputThumbnail';

interface OutputGridProps {
  generations: StudioGeneration[];
  emptyState: ReactNode;
}

export function OutputGrid({ generations, emptyState }: OutputGridProps) {
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
      {pendingGenerations.map((generation) => (
        <OutputProcessingSkeleton key={generation.id} mode={generation.mode} />
      ))}

      {failedGenerations.map((generation) => (
        <OutputErrorCard
          key={generation.id}
          mode={generation.mode}
          message={generation.metadata || null}
        />
      ))}

      {outputs.map((output) => (
        <OutputThumbnail
          key={output.id}
          mediaUrl={output.mediaUrl}
          filePath={output.filePath}
          type={output.type}
          generationMode={output.generationMode}
          title={output.type === 'video' ? 'Video output' : 'Image output'}
        />
      ))}
    </div>
  );
}
