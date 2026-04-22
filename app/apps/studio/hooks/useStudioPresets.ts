'use client';

import { useCallback, useState } from 'react';
import type { StudioBlock, StudioPreset, StudioPresetBlockCatalog } from '../types/presets';

interface PresetPayload {
  name: string;
  description?: string | null;
  category?: string | null;
  blocks: StudioBlock[];
  tags?: string[];
}

interface PresetUpdatePayload {
  name?: string;
  description?: string | null;
  category?: string | null;
  blocks?: StudioBlock[];
  tags?: string[];
}

interface PreviewPayload {
  provider?: string;
  model?: string;
  aspectRatio?: string;
}

interface UseStudioPresetsReturn {
  presets: StudioPreset[];
  blockCatalog: StudioPresetBlockCatalog | null;
  loading: boolean;
  error: string | null;
  fetchPresets: (category?: string) => Promise<StudioPreset[]>;
  fetchBlockCatalog: () => Promise<StudioPresetBlockCatalog | null>;
  createPreset: (payload: PresetPayload) => Promise<StudioPreset | null>;
  updatePreset: (id: string, payload: PresetUpdatePayload) => Promise<StudioPreset | null>;
  deletePreset: (id: string) => Promise<boolean>;
  generatePreview: (id: string, payload?: PreviewPayload) => Promise<StudioPreset | null>;
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

export function useStudioPresets(): UseStudioPresetsReturn {
  const [presets, setPresets] = useState<StudioPreset[]>([]);
  const [blockCatalog, setBlockCatalog] = useState<StudioPresetBlockCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPresets = useCallback(async (category?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = category ? `?category=${encodeURIComponent(category)}` : '';
      const response = await fetch(`/api/studio/presets${params}`);
      const data = await parseJsonResponse(response);
      const fetched = (data.presets ?? []) as StudioPreset[];
      setPresets(fetched);
      return fetched;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to fetch presets'));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchBlockCatalog = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/studio/presets/blocks');
      const data = await parseJsonResponse(response);
      const catalog = {
        blockTypes: data.blockTypes ?? [],
        categories: data.categories ?? [],
        blockOrder: data.blockOrder ?? [],
      } satisfies StudioPresetBlockCatalog;
      setBlockCatalog(catalog);
      return catalog;
    } catch (err) {
      const message = toErrorMessage(err, 'Failed to fetch block catalog');
      setError(message);
      return null;
    }
  }, []);

  const createPreset = useCallback(async (payload: PresetPayload) => {
    setError(null);
    try {
      const response = await fetch('/api/studio/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      await fetchPresets();
      return data.preset ?? null;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to create preset'));
      return null;
    }
  }, [fetchPresets]);

  const updatePreset = useCallback(async (id: string, payload: PresetUpdatePayload) => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/presets/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await parseJsonResponse(response);
      await fetchPresets();
      return data.preset ?? null;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to update preset'));
      return null;
    }
  }, [fetchPresets]);

  const deletePreset = useCallback(async (id: string) => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/presets/${id}`, { method: 'DELETE' });
      await parseJsonResponse(response);
      await fetchPresets();
      return true;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to delete preset'));
      return false;
    }
  }, [fetchPresets]);

  const generatePreview = useCallback(async (id: string, payload?: PreviewPayload) => {
    setError(null);
    try {
      const response = await fetch(`/api/studio/presets/${id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      });
      const data = await parseJsonResponse(response);
      await fetchPresets();
      return data.preset ?? null;
    } catch (err) {
      setError(toErrorMessage(err, 'Failed to generate preset preview'));
      return null;
    }
  }, [fetchPresets]);

  return {
    presets,
    blockCatalog,
    loading,
    error,
    fetchPresets,
    fetchBlockCatalog,
    createPreset,
    updatePreset,
    deletePreset,
    generatePreview,
  };
}
