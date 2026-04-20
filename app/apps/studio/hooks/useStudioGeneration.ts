'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  StudioGeneratePayload,
  StudioGenerateResponse,
  StudioGeneration,
  StudioGenerationMode,
  StudioGenerationOutput,
  StudioGenerationStatus,
} from '../types/generation';

const POLL_INTERVAL_MS = 10_000;

interface UseStudioGenerationReturn {
  generations: StudioGeneration[];
  currentGeneration: StudioGeneration | null;
  loading: boolean;
  error: string | null;
  isPolling: boolean;
  activeGenerationId: string | null;
  fetchGenerations: () => Promise<void>;
  fetchGeneration: (id: string, options?: { silent?: boolean }) => Promise<StudioGeneration | null>;
  generate: (payload: StudioGeneratePayload) => Promise<StudioGeneration | null>;
  deleteGeneration: (id: string) => Promise<boolean>;
  stopPolling: () => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

async function parseJsonResponse(response: Response) {
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
    aspectRatio: payload.aspect_ratio ?? '1:1',
    provider: payload.provider ?? 'gemini',
    model: '',
    status: (response.status || 'pending') as StudioGenerationStatus,
    outputs,
    products: payload.product_ids ?? [],
    personas: payload.persona_ids ?? [],
    product_ids: payload.product_ids ?? [],
    persona_ids: payload.persona_ids ?? [],
    createdAt: now,
    updatedAt: now,
    metadata: null,
  };
}

export function useStudioGeneration(): UseStudioGenerationReturn {
  const [generations, setGenerations] = useState<StudioGeneration[]>([]);
  const [currentGeneration, setCurrentGeneration] = useState<StudioGeneration | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setActiveGenerationId(null);
  }, []);

  const fetchGeneration = useCallback(async (id: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await fetch(`/api/studio/generations/${id}`);
      const data = await parseJsonResponse(response);
      const generation = (data.generation ?? null) as StudioGeneration | null;

      if (generation) {
        setCurrentGeneration(generation);
        setGenerations((current) => mergeGenerationLists(current, generation));

        if (generation.status === 'completed' || generation.status === 'failed') {
          stopPolling();
        }
      }

      return generation;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to fetch generation');
      setError(message);
      if (options?.silent) {
        stopPolling();
      }
      return null;
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, [stopPolling]);

  const fetchGenerations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/studio/generations');
      const data = await parseJsonResponse(response);
      const nextGenerations = (data.generations ?? []) as StudioGeneration[];
      setGenerations(nextGenerations);
      setCurrentGeneration((current) => {
        if (!current) {
          return nextGenerations[0] ?? null;
        }
        return nextGenerations.find((generation) => generation.id === current.id) ?? current;
      });
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to fetch generations'));
    } finally {
      setLoading(false);
    }
  }, []);

  const generate = useCallback(async (payload: StudioGeneratePayload) => {
    setLoading(true);
    setError(null);

    const temporaryId = `temp-${crypto.randomUUID()}`;
    const expectedCount = payload.mode === 'video' ? 1 : Math.min(Math.max(payload.count ?? 4, 1), 4);
    const temporaryGeneration: StudioGeneration = {
      id: temporaryId,
      userId: '',
      mode: payload.mode ?? 'image',
      prompt: payload.prompt,
      rawPrompt: payload.prompt,
      studioPresetId: payload.preset_id ?? null,
      aspectRatio: payload.aspect_ratio ?? '1:1',
      provider: payload.provider ?? 'gemini',
      model: '',
      status: 'pending',
      outputs: [],
      products: payload.product_ids ?? [],
      personas: payload.persona_ids ?? [],
      product_ids: payload.product_ids ?? [],
      persona_ids: payload.persona_ids ?? [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: JSON.stringify({ expectedCount }),
    };

    setCurrentGeneration(temporaryGeneration);
    setGenerations((current) => mergeGenerationLists(current, temporaryGeneration));

    try {
      const response = await fetch('/api/studio/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      const generation = createPendingGeneration(data.generationId, payload, data as StudioGenerateResponse);
      setCurrentGeneration(generation);
      setGenerations((current) => {
        const withoutTemporary = current.filter((item) => item.id !== temporaryId);
        return mergeGenerationLists(withoutTemporary, generation);
      });
      setActiveGenerationId(data.generationId);
      return generation;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to create generation');
      setError(message);
      const failedGeneration: StudioGeneration = {
        ...temporaryGeneration,
        status: 'failed',
        updatedAt: new Date().toISOString(),
        metadata: JSON.stringify({ expectedCount, error: message }),
      };
      setCurrentGeneration(failedGeneration);
      setGenerations((current) => {
        const withoutTemporary = current.filter((item) => item.id !== temporaryId);
        return mergeGenerationLists(withoutTemporary, failedGeneration);
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const deleteGeneration = useCallback(async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/generations/${id}`, { method: 'DELETE' });
      await parseJsonResponse(response);
      setGenerations((current) => current.filter((generation) => generation.id !== id));
      setCurrentGeneration((current) => (current?.id === id ? null : current));
      if (activeGenerationId === id) {
        stopPolling();
      }
      return true;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete generation'));
      return false;
    }
  }, [activeGenerationId, stopPolling]);

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
    error,
    isPolling: activeGenerationId !== null,
    activeGenerationId,
    fetchGenerations,
    fetchGeneration,
    generate,
    deleteGeneration,
    stopPolling,
  };
}
