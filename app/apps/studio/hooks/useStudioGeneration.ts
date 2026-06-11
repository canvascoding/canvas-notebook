'use client';

import { useCallback, useEffect, useRef } from 'react';
import { generateRandomId } from '@/app/lib/utils/random-id';
import { useStudioGenerationsCacheStore } from '@/app/store/studio-generations-cache-store';
import type {
  StudioGeneratePayload,
  StudioGenerateResponse,
  StudioGeneration,
  StudioGenerationMode,
  StudioGenerationOutput,
  StudioGenerationStatus,
} from '../types/generation';
import { getStudioUserPrompt } from '../utils/studio-generation-prompt';

const POLL_INTERVAL_MS = 10_000;
const GENERATIONS_PAGE_SIZE = 48;

interface UseStudioGenerationReturn {
  generations: StudioGeneration[];
  currentGeneration: StudioGeneration | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  isPolling: boolean;
  activeGenerationId: string | null;
  recentlyCompletedIds: Set<string>;
  hasMoreGenerations: boolean;
  fetchGenerations: () => Promise<void>;
  loadMoreGenerations: () => Promise<void>;
  fetchGeneration: (id: string, options?: { silent?: boolean }) => Promise<StudioGeneration | null>;
  watchGeneration: (id: string) => void;
  generate: (payload: StudioGeneratePayload) => Promise<StudioGeneration | null>;
  deleteGeneration: (id: string) => Promise<boolean>;
  deleteOutput: (generationId: string, outputId: string) => Promise<boolean>;
  toggleFavorite: (generationId: string, outputId: string, isFavorite: boolean) => Promise<boolean>;
  createVariation: (generation: StudioGeneration, output: StudioGenerationOutput) => Promise<StudioGeneration | null>;
  createVideoFromOutput: (generation: StudioGeneration, output: StudioGenerationOutput) => Promise<StudioGeneration | null>;
  stopPolling: () => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function parseJsonResponse(response: Response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json') && !contentType.includes('text/plain')) {
    throw new Error(`Server error: ${response.status}. Bitte versuche es erneut.`);
  }
  const data = await response.json();
  if (!response.ok || data?.success === false) {
    throw new Error(data?.error || `Request failed with ${response.status}`);
  }
  return data;
}

function mergeGenerationLists(current: StudioGeneration[], next: StudioGeneration): StudioGeneration[] {
  const remaining = current.filter((generation) => generation.id !== next.id);
  return [next, ...remaining].sort((a, b) => {
    const left = new Date(b.createdAt).getTime();
    const right = new Date(a.createdAt).getTime();
    return left - right;
  });
}

function mergeGenerationPages(current: StudioGeneration[], next: StudioGeneration[]): StudioGeneration[] {
  const byId = new Map<string, StudioGeneration>();
  for (const generation of current) {
    byId.set(generation.id, generation);
  }
  for (const generation of next) {
    byId.set(generation.id, generation);
  }
  return Array.from(byId.values()).sort((a, b) => {
    const left = new Date(b.createdAt).getTime();
    const right = new Date(a.createdAt).getTime();
    return left - right;
  });
}

function updateOutputInGeneration(
  generation: StudioGeneration,
  outputId: string,
  updater: (output: StudioGenerationOutput) => StudioGenerationOutput,
): StudioGeneration {
  return {
    ...generation,
    outputs: generation.outputs.map((output) => (output.id === outputId ? updater(output) : output)),
  };
}

function createPendingGeneration(
  generationId: string,
  payload: StudioGeneratePayload,
  response: StudioGenerateResponse,
): StudioGeneration {
  const now = new Date().toISOString();
  const outputs: StudioGenerationOutput[] = (response.outputs ?? []).map((output) => ({
    ...output,
    generationId,
    mediaUrl: output.mediaUrl ?? null,
    fileSize: output.fileSize ?? null,
    mimeType: output.mimeType ?? null,
    width: null,
    height: null,
    isFavorite: false,
    createdAt: now,
  }));

  return {
    id: generationId,
    userId: '',
    mode: (response.mode || payload.mode || 'image') as StudioGenerationMode,
    prompt: response.prompt ?? payload.prompt,
    rawPrompt: payload.prompt,
    studioPresetId: payload.preset_id ?? null,
    studioPresetName: null,
    aspectRatio: payload.aspect_ratio ?? '1:1',
    provider: payload.provider ?? 'gemini',
    model: payload.model ?? '',
    status: (response.status || 'pending') as StudioGenerationStatus,
    outputs,
    products: payload.product_ids ?? [],
    personas: payload.persona_ids ?? [],
    styles: payload.style_ids ?? [],
    product_ids: payload.product_ids ?? [],
    persona_ids: payload.persona_ids ?? [],
    style_ids: payload.style_ids ?? [],
    createdAt: now,
    updatedAt: now,
    metadata: null,
  };
}

const COMPLETED_ANIMATION_MS = 1500;

function setGenerationsState(
  updater: StudioGeneration[] | ((current: StudioGeneration[]) => StudioGeneration[]),
) {
  useStudioGenerationsCacheStore.setState((state) => ({
    generations: typeof updater === 'function' ? updater(state.generations) : updater,
  }));
}

function setCurrentGenerationState(
  updater: StudioGeneration | null | ((current: StudioGeneration | null) => StudioGeneration | null),
) {
  useStudioGenerationsCacheStore.setState((state) => ({
    currentGeneration: typeof updater === 'function' ? updater(state.currentGeneration) : updater,
  }));
}

function preserveActiveGenerations(
  current: StudioGeneration[],
  nextGenerations: StudioGeneration[],
): StudioGeneration[] {
  const nextIds = new Set(nextGenerations.map((generation) => generation.id));
  const optimistic = current.filter((generation) => {
    if (nextIds.has(generation.id)) return false;
    return generation.id.startsWith('temp-') || generation.status === 'pending' || generation.status === 'generating';
  });

  return mergeGenerationPages(optimistic, nextGenerations);
}

export function useStudioGeneration(): UseStudioGenerationReturn {
  const generations = useStudioGenerationsCacheStore((state) => state.generations);
  const currentGeneration = useStudioGenerationsCacheStore((state) => state.currentGeneration);
  const loading = useStudioGenerationsCacheStore((state) => state.loading);
  const loadingMore = useStudioGenerationsCacheStore((state) => state.loadingMore);
  const error = useStudioGenerationsCacheStore((state) => state.error);
  const activeGenerationId = useStudioGenerationsCacheStore((state) => state.activeGenerationId);
  const recentlyCompletedIds = useStudioGenerationsCacheStore((state) => state.recentlyCompletedIds);
  const hasMoreGenerations = useStudioGenerationsCacheStore((state) => state.hasMoreGenerations);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    useStudioGenerationsCacheStore.setState({ activeGenerationId: null });
  }, []);

  const fetchGeneration = useCallback(async (id: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      useStudioGenerationsCacheStore.setState({ loading: true });
    }
    useStudioGenerationsCacheStore.setState({ error: null });

    try {
      const response = await fetch(`/api/studio/generations/${id}`);
      const data = await parseJsonResponse(response);
      const generation = (data.generation ?? null) as StudioGeneration | null;

      if (generation) {
        const isTerminal = generation.status === 'completed' || generation.status === 'failed';

        setGenerationsState((current) => {
          const existing = current.find((g) => g.id === generation.id);
          if (existing && existing.status === generation.status && existing.outputs.length === generation.outputs.length) {
            return current;
          }
          return mergeGenerationLists(current, generation);
        });

        setCurrentGenerationState((current) => {
          if (current?.id === generation.id && current.status === generation.status && current.outputs.length === generation.outputs.length) {
            return current;
          }
          return generation;
        });

        if (isTerminal) {
          stopPolling();
          const genId = generation.id;
          useStudioGenerationsCacheStore.setState((state) => {
            const recentlyCompletedIds = new Set(state.recentlyCompletedIds);
            recentlyCompletedIds.add(genId);
            return { recentlyCompletedIds };
          });
          setTimeout(() => {
            useStudioGenerationsCacheStore.setState((state) => {
              const recentlyCompletedIds = new Set(state.recentlyCompletedIds);
              recentlyCompletedIds.delete(genId);
              return { recentlyCompletedIds };
            });
          }, COMPLETED_ANIMATION_MS);
        }
      }

      return generation;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to fetch generation');
      useStudioGenerationsCacheStore.setState({ error: message });
      if (options?.silent) {
        stopPolling();
      }
      return null;
    } finally {
      if (!options?.silent) {
        useStudioGenerationsCacheStore.setState({ loading: false });
      }
    }
  }, [stopPolling]);

  const fetchGenerations = useCallback(async () => {
    useStudioGenerationsCacheStore.setState({ loading: true, error: null });
    try {
      const response = await fetch(`/api/studio/generations?limit=${GENERATIONS_PAGE_SIZE}&offset=0`);
      const data = await parseJsonResponse(response);
      const nextGenerations = (data.generations ?? []) as StudioGeneration[];
      setGenerationsState((current) => preserveActiveGenerations(current, nextGenerations));
      useStudioGenerationsCacheStore.setState({ hasMoreGenerations: Boolean(data.hasMore) });
      setCurrentGenerationState((current) => {
        const latestGenerations = preserveActiveGenerations(
          useStudioGenerationsCacheStore.getState().generations,
          nextGenerations,
        );
        if (!current) {
          return latestGenerations[0] ?? null;
        }
        return latestGenerations.find((generation) => generation.id === current.id) ?? current;
      });
    } catch (err) {
      useStudioGenerationsCacheStore.setState({ error: toErrorMessage(err, 'Failed to fetch generations') });
    } finally {
      useStudioGenerationsCacheStore.setState({ loading: false });
    }
  }, []);

  const loadMoreGenerations = useCallback(async () => {
    const { generations, hasMoreGenerations, loadingMore } = useStudioGenerationsCacheStore.getState();
    if (loadingMore || !hasMoreGenerations) {
      return;
    }

    useStudioGenerationsCacheStore.setState({ loadingMore: true, error: null });
    try {
      const loadedServerGenerationCount = generations.filter((generation) => !generation.id.startsWith('temp-')).length;
      const response = await fetch(`/api/studio/generations?limit=${GENERATIONS_PAGE_SIZE}&offset=${loadedServerGenerationCount}`);
      const data = await parseJsonResponse(response);
      const nextGenerations = (data.generations ?? []) as StudioGeneration[];
      setGenerationsState((current) => mergeGenerationPages(current, nextGenerations));
      useStudioGenerationsCacheStore.setState({ hasMoreGenerations: Boolean(data.hasMore) });
    } catch (err) {
      useStudioGenerationsCacheStore.setState({ error: toErrorMessage(err, 'Failed to load more generations') });
    } finally {
      useStudioGenerationsCacheStore.setState({ loadingMore: false });
    }
  }, []);

  const watchGeneration = useCallback((id: string) => {
    useStudioGenerationsCacheStore.setState({ activeGenerationId: id });
  }, []);

  const generate = useCallback(async (payload: StudioGeneratePayload) => {
    useStudioGenerationsCacheStore.setState({ loading: true, error: null });

    const temporaryId = `temp-${generateRandomId()}`;
    const expectedCount = payload.mode === 'video' || payload.mode === 'sound' ? 1 : Math.min(Math.max(payload.count ?? 1, 1), 4);
    const temporaryGeneration: StudioGeneration = {
      id: temporaryId,
      userId: '',
      mode: payload.mode ?? 'image',
      prompt: payload.prompt,
      rawPrompt: payload.prompt,
      studioPresetId: payload.preset_id ?? null,
      studioPresetName: null,
    aspectRatio: payload.aspect_ratio ?? '1:1',
      provider: payload.provider ?? 'gemini',
      model: payload.model ?? '',
      status: 'pending',
      outputs: [],
      products: payload.product_ids ?? [],
      personas: payload.persona_ids ?? [],
      styles: payload.style_ids ?? [],
      product_ids: payload.product_ids ?? [],
      persona_ids: payload.persona_ids ?? [],
      style_ids: payload.style_ids ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: JSON.stringify({ expectedCount }),
    };

    setCurrentGenerationState(temporaryGeneration);
    setGenerationsState((current) => mergeGenerationLists(current, temporaryGeneration));

    try {
      const response = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      const generation = createPendingGeneration(data.generationId, payload, data as StudioGenerateResponse);
      setCurrentGenerationState(generation);
      setGenerationsState((current) => {
        const withoutTemporary = current.filter((item) => item.id !== temporaryId);
        return mergeGenerationLists(withoutTemporary, generation);
      });
      useStudioGenerationsCacheStore.setState({ activeGenerationId: data.generationId });
      return generation;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to create generation');
      useStudioGenerationsCacheStore.setState({ error: message });
      const failedGeneration: StudioGeneration = {
        ...temporaryGeneration,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        metadata: JSON.stringify({ expectedCount, error: message }),
      };
      setCurrentGenerationState(failedGeneration);
      setGenerationsState((current) => {
        const withoutTemporary = current.filter((item) => item.id !== temporaryId);
        return mergeGenerationLists(withoutTemporary, failedGeneration);
      });
      return null;
    } finally {
      useStudioGenerationsCacheStore.setState({ loading: false });
    }
  }, []);

  const deleteGeneration = useCallback(async (id: string) => {
    useStudioGenerationsCacheStore.setState({ error: null });
    try {
      const response = await fetch(`/api/studio/generations/${id}`, { method: 'DELETE' });
      await parseJsonResponse(response);
      setGenerationsState((current) => current.filter((generation) => generation.id !== id));
      setCurrentGenerationState((current) => (current?.id === id ? null : current));
      if (activeGenerationId === id) {
        stopPolling();
      }
      return true;
    } catch (err) {
      useStudioGenerationsCacheStore.setState({ error: toErrorMessage(err, 'Failed to delete generation') });
      return false;
    }
  }, [activeGenerationId, stopPolling]);

  const deleteOutput = useCallback(async (generationId: string, outputId: string) => {
    useStudioGenerationsCacheStore.setState({ error: null });
    try {
      const response = await fetch(`/api/studio/generations/${generationId}/outputs/${outputId}`, { method: 'DELETE' });
      const data = await parseJsonResponse(response);
      const generationDeleted = data.generationDeleted === true;

      if (generationDeleted) {
        setGenerationsState((current) => current.filter((g) => g.id !== generationId));
        setCurrentGenerationState((current) => (current?.id === generationId ? null : current));
        if (activeGenerationId === generationId) {
          stopPolling();
        }
      } else {
        setGenerationsState((current) =>
          current.map((g) =>
            g.id === generationId
              ? { ...g, outputs: g.outputs.filter((o) => o.id !== outputId) }
              : g,
          ),
        );
        setCurrentGenerationState((current) =>
          current?.id === generationId
            ? { ...current, outputs: current.outputs.filter((o) => o.id !== outputId) }
            : current,
        );
      }

      return true;
    } catch (err) {
      useStudioGenerationsCacheStore.setState({ error: toErrorMessage(err, 'Failed to delete output') });
      return false;
    }
  }, [activeGenerationId, stopPolling]);

  const toggleFavorite = useCallback(async (generationId: string, outputId: string, isFavorite: boolean) => {
    useStudioGenerationsCacheStore.setState({ error: null });
    setGenerationsState((current) =>
      current.map((generation) =>
        generation.id === generationId
          ? updateOutputInGeneration(generation, outputId, (output) => ({ ...output, isFavorite }))
          : generation,
      ),
    );
    setCurrentGenerationState((current) =>
      current?.id === generationId ? updateOutputInGeneration(current, outputId, (output) => ({ ...output, isFavorite })) : current,
    );

    try {
      const response = await fetch(`/api/studio/generations/${generationId}/outputs/${outputId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFavorite }),
      });
      await parseJsonResponse(response);
      return true;
    } catch (err) {
      useStudioGenerationsCacheStore.setState({ error: toErrorMessage(err, 'Failed to update favorite') });
      setGenerationsState((current) =>
        current.map((generation) =>
          generation.id === generationId
            ? updateOutputInGeneration(generation, outputId, (output) => ({ ...output, isFavorite: !isFavorite }))
            : generation,
        ),
      );
      setCurrentGenerationState((current) =>
        current?.id === generationId
          ? updateOutputInGeneration(current, outputId, (output) => ({ ...output, isFavorite: !isFavorite }))
          : current,
      );
      return false;
    }
  }, []);

  const createVariation = useCallback(async (generation: StudioGeneration, output: StudioGenerationOutput) => {
    return generate({
      prompt: getStudioUserPrompt(generation),
      mode: 'image',
      product_ids: generation.product_ids ?? [],
      persona_ids: generation.persona_ids ?? [],
      preset_id: generation.studioPresetId ?? undefined,
      aspect_ratio: generation.aspectRatio,
      count: 4,
      provider: generation.provider,
      source_output_id: output.id,
    });
  }, [generate]);

  const createVideoFromOutput = useCallback(async (generation: StudioGeneration, output: StudioGenerationOutput) => {
    return generate({
      prompt: getStudioUserPrompt(generation),
      mode: 'video',
      product_ids: generation.product_ids ?? [],
      persona_ids: generation.persona_ids ?? [],
      preset_id: generation.studioPresetId ?? undefined,
      aspect_ratio: generation.aspectRatio,
      count: 1,
      provider: generation.provider,
      source_output_id: output.id,
    });
  }, [generate]);

  useEffect(() => {
    if (!activeGenerationId) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    void fetchGeneration(activeGenerationId, { silent: true });

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = setInterval(() => {
      void fetchGeneration(activeGenerationId, { silent: true });
    }, POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [activeGenerationId, fetchGeneration]);

  useEffect(() => () => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  }, []);

  return {
    generations,
    currentGeneration,
    loading,
    loadingMore,
    error,
    isPolling: activeGenerationId !== null,
    activeGenerationId,
    recentlyCompletedIds,
    hasMoreGenerations,
    fetchGenerations,
    loadMoreGenerations,
    fetchGeneration,
    watchGeneration,
    generate,
    deleteGeneration,
    deleteOutput,
    toggleFavorite,
    createVariation,
    createVideoFromOutput,
    stopPolling,
  };
}
