'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Trash2, Pencil, Plus, Loader2, Expand, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { ReferencePickerDialog } from '../create/ReferencePickerDialog';
import { ModelImagePreviewDialog } from './ModelImagePreviewDialog';
import type { StudioProduct, StudioProductImage, StudioPersona, StudioPersonaImage, StudioStyle, StudioStyleImage } from '../../types/models';

interface UploadingImage {
  id: string;
  fileName: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

interface ModelDetailDialogProps {
  entityId: string;
  entityType: 'product' | 'persona' | 'style';
}

export function ModelDetailDialog({ entityId, entityType }: ModelDetailDialogProps) {
  const t = useTranslations('studio');
  const router = useRouter();
  const [entity, setEntity] = useState<StudioProduct | StudioPersona | StudioStyle | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [nameValue, setNameValue] = useState('');
  const [descriptionValue, setDescriptionValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [uploadingImages, setUploadingImages] = useState<UploadingImage[]>([]);

  const fetchEntity = useCallback(async () => {
    setLoading(true);
    try {
      const endpoint = entityType === 'product'
        ? `/api/studio/products/${entityId}`
        : entityType === 'persona'
        ? `/api/studio/personas/${entityId}`
        : `/api/studio/styles/${entityId}`;
      const res = await fetch(endpoint);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      const item = data.product ?? data.persona ?? data.style;
      setEntity(item);
      setNameValue(item.name);
      setDescriptionValue(item.description ?? '');
    } catch {
      setEntity(null);
    } finally {
      setLoading(false);
    }
  }, [entityId, entityType]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchEntity();
  }, [fetchEntity]);

  const images = entity?.images ?? [];
  const imageCount = images.length + uploadingImages.filter((u) => u.status !== 'error').length;

  const getUploadEndpoint = useCallback(() => {
    if (entityType === 'product') return `/api/studio/products/${entityId}/images`;
    if (entityType === 'persona') return `/api/studio/personas/${entityId}/images`;
    return `/api/studio/styles/${entityId}/images`;
  }, [entityType, entityId]);

  const addImageFromFilePath = useCallback(async (filePath: string) => {
    const res = await fetch(getUploadEndpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(data.error || 'Upload failed');
    }
    return res.json();
  }, [getUploadEndpoint]);

  const addImageFromFile = useCallback(async (file: File, onProgress?: (pct: number) => void) => {
    const formData = new FormData();
    formData.append('file', file);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', getUploadEndpoint());
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            resolve(xhr.responseText);
          }
        } else {
          let msg = 'Upload failed';
          try {
            const d = JSON.parse(xhr.responseText);
            msg = d.error || msg;
          } catch { /* ignore */ }
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });
  }, [getUploadEndpoint]);

  const handlePickerConfirm = useCallback(async (paths: string[]) => {
    const remainingSlots = 10 - images.length;
    const toAdd = paths.slice(0, remainingSlots);
    if (toAdd.length === 0) return;

    setSaving(true);
    try {
      // Workspace / studio assets -> filePath-Import (schnell, kein doppelter Transfer)
      const filePathTasks = toAdd.map((path) =>
        addImageFromFilePath(path).catch((err) => {
          toast.error(`${t('modelDetail.addImageError')}: ${err.message}`);
          return null;
        })
      );
      await Promise.all(filePathTasks);
      await fetchEntity();
      toast.success(t('modelDetail.imagesAdded'));
    } catch {
      toast.error(t('modelDetail.addImageError'));
    } finally {
      setSaving(false);
    }
  }, [images.length, addImageFromFilePath, fetchEntity, t]);

  const handleUploadFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const remainingSlots = 10 - images.length;
    const toUpload = Array.from(files).slice(0, remainingSlots);
    if (toUpload.length === 0) {
      toast.warning(t('modelDetail.maxImagesReached'));
      return;
    }

    const newUploads: UploadingImage[] = toUpload.map((file) => ({
      id: `${Date.now()}-${Math.random()}`,
      fileName: file.name,
      progress: 0,
      status: 'uploading' as const,
    }));
    setUploadingImages((prev) => [...prev, ...newUploads]);

    await Promise.all(
      toUpload.map(async (file, index) => {
        const uploadId = newUploads[index].id;
        try {
          await addImageFromFile(file, (pct) => {
            setUploadingImages((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, progress: pct } : u))
            );
          });
          setUploadingImages((prev) =>
            prev.map((u) => (u.id === uploadId ? { ...u, progress: 100, status: 'done' as const } : u))
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Upload failed';
          setUploadingImages((prev) =>
            prev.map((u) => (u.id === uploadId ? { ...u, status: 'error' as const, error: msg } : u))
          );
          toast.error(`${file.name}: ${msg}`);
        }
      })
    );

    // Clean up done uploads after a moment and refresh
    setTimeout(() => {
      setUploadingImages((prev) => prev.filter((u) => u.status !== 'done'));
      void fetchEntity();
    }, 1500);
    void fetchEntity();
  }, [images.length, addImageFromFile, fetchEntity, t]);

  const handleSaveName = useCallback(async () => {
    if (!nameValue.trim()) return;
    setSaving(true);
    try {
      const endpoint = entityType === 'product'
        ? `/api/studio/products/${entityId}`
        : entityType === 'persona'
        ? `/api/studio/personas/${entityId}`
        : `/api/studio/styles/${entityId}`;
      await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: nameValue.trim() }),
      });
      setEditingName(false);
      await fetchEntity();
    } finally {
      setSaving(false);
    }
  }, [nameValue, entityId, entityType, fetchEntity]);

  const handleSaveDescription = useCallback(async () => {
    setSaving(true);
    try {
      const endpoint = entityType === 'product'
        ? `/api/studio/products/${entityId}`
        : entityType === 'persona'
        ? `/api/studio/personas/${entityId}`
        : `/api/studio/styles/${entityId}`;
      await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: descriptionValue.trim() || undefined }),
      });
      setEditingDescription(false);
      await fetchEntity();
    } finally {
      setSaving(false);
    }
  }, [descriptionValue, entityId, entityType, fetchEntity]);

  const handleDeleteImage = useCallback(async (imageId: string) => {
    const endpoint = entityType === 'product'
      ? `/api/studio/products/${entityId}/images/${imageId}`
      : entityType === 'persona'
      ? `/api/studio/personas/${entityId}/images/${imageId}`
      : `/api/studio/styles/${entityId}/images/${imageId}`;
    await fetch(endpoint, { method: 'DELETE' });
    await fetchEntity();
  }, [entityId, entityType, fetchEntity]);

  const handleDeleteEntity = useCallback(async () => {
    setSaving(true);
    try {
      const endpoint = entityType === 'product'
        ? `/api/studio/products/${entityId}`
        : entityType === 'persona'
        ? `/api/studio/personas/${entityId}`
        : `/api/studio/styles/${entityId}`;
      await fetch(endpoint, { method: 'DELETE' });
      router.push('/studio/models');
    } finally {
      setSaving(false);
    }
  }, [entityId, entityType, router]);

  const getImageUrl = (imageId: string) => {
    return entityType === 'product'
      ? `/api/studio/products/${entityId}/images/${imageId}`
      : entityType === 'persona'
      ? `/api/studio/personas/${entityId}/images/${imageId}`
      : `/api/studio/styles/${entityId}/images/${imageId}`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!entity) {
    return <p className="py-16 text-center text-muted-foreground">{t('modelDetail.notFound')}</p>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-10">
      <div className="space-y-2">
        {editingName ? (
          <div className="flex gap-2">
            <Input value={nameValue} onChange={(e) => setNameValue(e.target.value)} className="text-lg font-semibold" />
            <Button size="sm" onClick={handleSaveName} disabled={saving}>{t('modelDetail.save')}</Button>
            <Button size="sm" variant="outline" onClick={() => { setEditingName(false); setNameValue(entity.name); }}>{t('modelDetail.cancel')}</Button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">{entity.name}</h2>
            <button onClick={() => setEditingName(true)} className="text-muted-foreground hover:text-foreground"><Pencil className="h-4 w-4" /></button>
          </div>
        )}
        {editingDescription ? (
          <div className="flex flex-col gap-2">
            <textarea
              value={descriptionValue}
              onChange={(e) => setDescriptionValue(e.target.value)}
              rows={3}
              className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveDescription} disabled={saving}>{t('modelDetail.save')}</Button>
              <Button size="sm" variant="outline" onClick={() => { setEditingDescription(false); setDescriptionValue(entity.description ?? ''); }}>{t('modelDetail.cancel')}</Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <p className="text-sm text-muted-foreground">{entity.description || t('modelDetail.noDescription')}</p>
            <button onClick={() => setEditingDescription(true)} className="shrink-0 text-muted-foreground hover:text-foreground"><Pencil className="h-3 w-3" /></button>
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">{t('modelDetail.images')} ({imageCount}/10)</h3>
          {imageCount < 10 && (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowPicker(true)} className="gap-1" disabled={saving}>
                <Plus className="h-3 w-3" />
                {t('modelDetail.addImages')}
              </Button>
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                id="model-detail-file-input"
                onChange={(e) => {
                  void handleUploadFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <Button size="sm" variant="outline" asChild className="gap-1" disabled={saving}>
                <label htmlFor="model-detail-file-input" className="cursor-pointer">
                  <Plus className="h-3 w-3" />
                  {t('modelDetail.uploadFiles')}
                </label>
              </Button>
            </div>
          )}
        </div>

        {/* Upload progress cards */}
        {uploadingImages.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
            {uploadingImages.map((u) => (
              <div key={u.id} className="relative aspect-square overflow-hidden rounded-md border border-border bg-muted flex flex-col items-center justify-center gap-2 p-2">
                {u.status === 'error' ? (
                  <>
                    <AlertCircle className="h-6 w-6 text-destructive" />
                    <p className="text-xs text-destructive text-center line-clamp-2">{u.error}</p>
                  </>
                ) : (
                  <>
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    <p className="text-xs text-muted-foreground text-center line-clamp-1">{u.fileName}</p>
                    <Progress value={u.progress} className="h-1.5 w-full" />
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {images.map((img: StudioProductImage | StudioPersonaImage | StudioStyleImage, index: number) => (
            <div
              key={img.id}
              className="group relative aspect-square cursor-pointer overflow-hidden rounded-md border border-border"
              onClick={() => setPreviewIndex(index)}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={getImageUrl(img.id)} alt={img.fileName} className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                <Button size="sm" variant="secondary" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); setPreviewIndex(index); }}>
                  <Expand className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); handleDeleteImage(img.id); }}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-4">
        {showDeleteConfirm ? (
          <Card className="border-destructive/50 bg-destructive/10 p-4 space-y-3">
            <p className="text-sm text-destructive">{t('modelDetail.deleteConfirmMessage')}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleDeleteEntity} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('modelDetail.confirmDelete')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setShowDeleteConfirm(false)}>{t('modelDetail.cancel')}</Button>
            </div>
          </Card>
        ) : (
          <Button size="sm" variant="destructive" onClick={() => setShowDeleteConfirm(true)} className="gap-2">
            <Trash2 className="h-4 w-4" />
            {entityType === 'product' ? t('modelDetail.deleteProduct') : entityType === 'persona' ? t('modelDetail.deletePersona') : t('modelDetail.deleteStyle')}
          </Button>
        )}
      </div>

      <ReferencePickerDialog
        open={showPicker}
        onOpenChange={setShowPicker}
        onConfirm={handlePickerConfirm}
      />

      {previewIndex !== null && (
        <ModelImagePreviewDialog
          images={images}
          initialIndex={previewIndex}
          entityId={entityId}
          entityType={entityType}
          onClose={() => setPreviewIndex(null)}
        />
      )}
    </div>
  );
}
