'use client';

import { useState, useCallback } from 'react';
import type { StudioPersona } from '../types/models';

interface UseStudioPersonasReturn {
  personas: StudioPersona[];
  loading: boolean;
  error: string | null;
  fetchPersonas: (search?: string) => Promise<void>;
  createPersona: (data: { name: string; description?: string }) => Promise<StudioPersona | null>;
  updatePersona: (id: string, data: { name?: string; description?: string; imageOrder?: string[] }) => Promise<StudioPersona | null>;
  deletePersona: (id: string) => Promise<{ success: boolean; warnings?: string[] } | null>;
  addImage: (personaId: string, file: File) => Promise<StudioPersonaImage | null>;
  addImageFromUrl: (personaId: string, url: string) => Promise<StudioPersonaImage | null>;
  deleteImage: (personaId: string, imageId: string) => Promise<boolean>;
  replaceImage: (personaId: string, imageId: string, file: File) => Promise<StudioPersonaImage | null>;
  reorderImages: (personaId: string, imageOrder: string[]) => Promise<boolean>;
  getImageUrl: (personaId: string, imageId: string) => string;
}

interface StudioPersonaImage {
  id: string;
  personaId: string;
  filePath: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
  sourceType: 'upload' | 'url_import';
  sourceUrl?: string;
  sortOrder: number;
  width?: number;
  height?: number;
  createdAt: string;
}

export function useStudioPersonas(): UseStudioPersonasReturn {
  const [personas, setPersonas] = useState<StudioPersona[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPersonas = useCallback(async (search?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/studio/personas${params}`);
      if (!res.ok) throw new Error('Failed to fetch personas');
      const data = await res.json();
      setPersonas(data.personas ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const createPersona = useCallback(async (data: { name: string; description?: string }): Promise<StudioPersona | null> => {
    setError(null);
    try {
      const res = await fetch('/api/studio/personas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create persona');
      const result = await res.json();
      await fetchPersonas();
      return result.persona ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const updatePersona = useCallback(async (id: string, data: { name?: string; description?: string; imageOrder?: string[] }): Promise<StudioPersona | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/personas/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update persona');
      const result = await res.json();
      await fetchPersonas();
      return result.persona ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const deletePersona = useCallback(async (id: string): Promise<{ success: boolean; warnings?: string[] } | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/personas/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete persona');
      const result = await res.json();
      await fetchPersonas();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const addImage = useCallback(async (personaId: string, file: File): Promise<StudioPersonaImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/personas/${personaId}/images`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to add image');
      const result = await res.json();
      await fetchPersonas();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const addImageFromUrl = useCallback(async (personaId: string, url: string): Promise<StudioPersonaImage | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/personas/${personaId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error('Failed to add image from URL');
      const result = await res.json();
      await fetchPersonas();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const deleteImage = useCallback(async (personaId: string, imageId: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/personas/${personaId}/images/${imageId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete image');
      await fetchPersonas();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchPersonas]);

  const replaceImage = useCallback(async (personaId: string, imageId: string, file: File): Promise<StudioPersonaImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/personas/${personaId}/images/${imageId}/replace`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to replace image');
      const result = await res.json();
      await fetchPersonas();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchPersonas]);

  const reorderImages = useCallback(async (personaId: string, imageOrder: string[]): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/personas/${personaId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder images');
      await fetchPersonas();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchPersonas]);

  const getImageUrl = useCallback((personaId: string, imageId: string): string => {
    return `/api/studio/personas/${personaId}/images/${imageId}`;
  }, []);

  return {
    personas,
    loading,
    error,
    fetchPersonas,
    createPersona,
    updatePersona,
    deletePersona,
    addImage,
    addImageFromUrl,
    deleteImage,
    replaceImage,
    reorderImages,
    getImageUrl,
  };
}