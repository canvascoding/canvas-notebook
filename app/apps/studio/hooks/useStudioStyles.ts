'use client';

import { useState, useCallback } from 'react';
import type { StudioStyle } from '../types/models';

interface UseStudioStylesReturn {
  styles: StudioStyle[];
  loading: boolean;
  error: string | null;
  fetchStyles: (search?: string) => Promise<void>;
  createStyle: (data: { name: string; description?: string }) => Promise<StudioStyle | null>;
  updateStyle: (id: string, data: { name?: string; description?: string; imageOrder?: string[] }) => Promise<StudioStyle | null>;
  deleteStyle: (id: string) => Promise<{ success: boolean; warnings?: string[] } | null>;
  addImage: (styleId: string, file: File) => Promise<StudioStyleImage | null>;
  addImageFromUrl: (styleId: string, url: string) => Promise<StudioStyleImage | null>;
  deleteImage: (styleId: string, imageId: string) => Promise<boolean>;
  replaceImage: (styleId: string, imageId: string, file: File) => Promise<StudioStyleImage | null>;
  reorderImages: (styleId: string, imageOrder: string[]) => Promise<boolean>;
  getImageUrl: (styleId: string, imageId: string) => string;
}

interface StudioStyleImage {
  id: string;
  styleId: string;
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

export function useStudioStyles(): UseStudioStylesReturn {
  const [styles, setStyles] = useState<StudioStyle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStyles = useCallback(async (search?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/studio/styles${params}`);
      if (!res.ok) throw new Error('Failed to fetch styles');
      const data = await res.json();
      setStyles(data.styles ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const createStyle = useCallback(async (data: { name: string; description?: string }): Promise<StudioStyle | null> => {
    setError(null);
    try {
      const res = await fetch('/api/studio/styles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create style');
      const result = await res.json();
      await fetchStyles();
      return result.style ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const updateStyle = useCallback(async (id: string, data: { name?: string; description?: string; imageOrder?: string[] }): Promise<StudioStyle | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/styles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update style');
      const result = await res.json();
      await fetchStyles();
      return result.style ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const deleteStyle = useCallback(async (id: string): Promise<{ success: boolean; warnings?: string[] } | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/styles/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete style');
      const result = await res.json();
      await fetchStyles();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const addImage = useCallback(async (styleId: string, file: File): Promise<StudioStyleImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/styles/${styleId}/images`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to add image');
      const result = await res.json();
      await fetchStyles();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const addImageFromUrl = useCallback(async (styleId: string, url: string): Promise<StudioStyleImage | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/styles/${styleId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error('Failed to add image from URL');
      const result = await res.json();
      await fetchStyles();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const deleteImage = useCallback(async (styleId: string, imageId: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/styles/${styleId}/images/${imageId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete image');
      await fetchStyles();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchStyles]);

  const replaceImage = useCallback(async (styleId: string, imageId: string, file: File): Promise<StudioStyleImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/styles/${styleId}/images/${imageId}/replace`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to replace image');
      const result = await res.json();
      await fetchStyles();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchStyles]);

  const reorderImages = useCallback(async (styleId: string, imageOrder: string[]): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/styles/${styleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder images');
      await fetchStyles();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchStyles]);

  const getImageUrl = useCallback((styleId: string, imageId: string): string => {
    return `/api/studio/styles/${styleId}/images/${imageId}`;
  }, []);

  return {
    styles,
    loading,
    error,
    fetchStyles,
    createStyle,
    updateStyle,
    deleteStyle,
    addImage,
    addImageFromUrl,
    deleteImage,
    replaceImage,
    reorderImages,
    getImageUrl,
  };
}
