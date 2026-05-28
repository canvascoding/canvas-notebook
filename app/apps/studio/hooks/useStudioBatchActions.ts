'use client';

import { useCallback } from 'react';
import { downloadStudioOutputs } from '../utils/downloadStudioOutput';

interface BatchDeleteResult {
  success: boolean;
  generationDeleted: boolean;
  generationId: string;
  outputId: string;
}

export function useStudioBatchActions() {
  const batchDeleteOutputs = useCallback(async (
    outputPairs: Array<{ generationId: string; outputId: string }>,
  ): Promise<BatchDeleteResult[]> => {
    const results = await Promise.allSettled(
      outputPairs.map(async ({ generationId, outputId }) => {
        const response = await fetch(`/api/studio/generations/${generationId}/outputs/${outputId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({ error: 'Request failed' }));
          throw new Error(data.error || `Failed to delete output ${outputId}`);
        }
        const data = await response.json();
        return {
          success: true,
          generationDeleted: data.generationDeleted === true,
          generationId,
          outputId,
        } as BatchDeleteResult;
      }),
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      return {
        success: false,
        generationDeleted: false,
        generationId: outputPairs[index].generationId,
        outputId: outputPairs[index].outputId,
      };
    });
  }, []);

  const batchToggleFavorites = useCallback(async (
    pairs: Array<{ generationId: string; outputId: string; isFavorite: boolean }>,
  ): Promise<boolean[]> => {
    const results = await Promise.allSettled(
      pairs.map(async ({ generationId, outputId, isFavorite }) => {
        const response = await fetch(`/api/studio/generations/${generationId}/outputs/${outputId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isFavorite }),
        });
        if (!response.ok) {
          throw new Error(`Failed to update favorite for output ${outputId}`);
        }
        return true;
      }),
    );

    return results.map((result) => result.status === 'fulfilled');
  }, []);

  const downloadAsZip = useCallback(async (
    outputIds: string[],
  ): Promise<boolean> => {
    return downloadStudioOutputs(outputIds);
  }, []);

  return {
    batchDeleteOutputs,
    batchToggleFavorites,
    downloadAsZip,
  };
}
