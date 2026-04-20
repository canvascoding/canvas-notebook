'use client';

import { useState, useCallback } from 'react';
import type { StudioProduct } from '../types/models';

interface UseStudioProductsReturn {
  products: StudioProduct[];
  loading: boolean;
  error: string | null;
  fetchProducts: (search?: string) => Promise<void>;
  createProduct: (data: { name: string; description?: string }) => Promise<StudioProduct | null>;
  updateProduct: (id: string, data: { name?: string; description?: string; imageOrder?: string[] }) => Promise<StudioProduct | null>;
  deleteProduct: (id: string) => Promise<{ success: boolean; warnings?: string[] } | null>;
  addImage: (productId: string, file: File) => Promise<StudioProductImage | null>;
  addImageFromUrl: (productId: string, url: string) => Promise<StudioProductImage | null>;
  deleteImage: (productId: string, imageId: string) => Promise<boolean>;
  replaceImage: (productId: string, imageId: string, file: File) => Promise<StudioProductImage | null>;
  reorderImages: (productId: string, imageOrder: string[]) => Promise<boolean>;
  getImageUrl: (productId: string, imageId: string) => string;
}

interface StudioProductImage {
  id: string;
  productId: string;
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

export function useStudioProducts(): UseStudioProductsReturn {
  const [products, setProducts] = useState<StudioProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchProducts = useCallback(async (search?: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = search ? `?search=${encodeURIComponent(search)}` : '';
      const res = await fetch(`/api/studio/products${params}`);
      if (!res.ok) throw new Error('Failed to fetch products');
      const data = await res.json();
      setProducts(data.products ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }, []);

  const createProduct = useCallback(async (data: { name: string; description?: string }): Promise<StudioProduct | null> => {
    setError(null);
    try {
      const res = await fetch('/api/studio/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to create product');
      const result = await res.json();
      await fetchProducts();
      return result.product ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const updateProduct = useCallback(async (id: string, data: { name?: string; description?: string; imageOrder?: string[] }): Promise<StudioProduct | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/products/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Failed to update product');
      const result = await res.json();
      await fetchProducts();
      return result.product ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const deleteProduct = useCallback(async (id: string): Promise<{ success: boolean; warnings?: string[] } | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/products/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete product');
      const result = await res.json();
      await fetchProducts();
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const addImage = useCallback(async (productId: string, file: File): Promise<StudioProductImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/products/${productId}/images`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to add image');
      const result = await res.json();
      await fetchProducts();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const addImageFromUrl = useCallback(async (productId: string, url: string): Promise<StudioProductImage | null> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/products/${productId}/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error('Failed to add image from URL');
      const result = await res.json();
      await fetchProducts();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const deleteImage = useCallback(async (productId: string, imageId: string): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/products/${productId}/images/${imageId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete image');
      await fetchProducts();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchProducts]);

  const replaceImage = useCallback(async (productId: string, imageId: string, file: File): Promise<StudioProductImage | null> => {
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`/api/studio/products/${productId}/images/${imageId}/replace`, {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Failed to replace image');
      const result = await res.json();
      await fetchProducts();
      return result.image ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return null;
    }
  }, [fetchProducts]);

  const reorderImages = useCallback(async (productId: string, imageOrder: string[]): Promise<boolean> => {
    setError(null);
    try {
      const res = await fetch(`/api/studio/products/${productId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder images');
      await fetchProducts();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      return false;
    }
  }, [fetchProducts]);

  const getImageUrl = useCallback((productId: string, imageId: string): string => {
    return `/api/studio/products/${productId}/images/${imageId}`;
  }, []);

  return {
    products,
    loading,
    error,
    fetchProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    addImage,
    addImageFromUrl,
    deleteImage,
    replaceImage,
    reorderImages,
    getImageUrl,
  };
}