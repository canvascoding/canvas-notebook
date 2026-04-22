'use client';

import { useTranslations } from 'next-intl';
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Trash2, Pencil, Plus, Loader2 } from 'lucide-react';
import { ReferencePickerDialog } from '../create/ReferencePickerDialog';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import type { StudioProduct, StudioProductImage, StudioPersona, StudioPersonaImage, StudioStyle, StudioStyleImage } from '../../types/models';

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

  useEffect(() => { fetchEntity(); }, [fetchEntity]);

  const images = entity?.images ?? [];
  const imageCount = images.length;

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

  const handlePickerConfirm = useCallback(async (paths: string[]) => {
    const remainingSlots = 10 - imageCount;
    const toAdd = paths.slice(0, remainingSlots);
    if (toAdd.length === 0) return;

    setSaving(true);
    try {
      for (const path of toAdd) {
        try {
          const res = await fetch(toMediaUrl(path));
          if (!res.ok) continue;
          const blob = await res.blob();
          const fileName = path.split('/').pop() || 'image.jpg';
          const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
          const formData = new FormData();
          formData.append('file', file);
          const endpoint = entityType === 'product'
            ? `/api/studio/products/${entityId}/images`
            : entityType === 'persona'
            ? `/api/studio/personas/${entityId}/images`
            : `/api/studio/styles/${entityId}/images`;
          await fetch(endpoint, { method: 'POST', body: formData });
        } catch {
          // skip failed downloads
        }
      }
      await fetchEntity();
    } finally {
      setSaving(false);
    }
  }, [entityId, entityType, imageCount, fetchEntity]);

  const handlePickerUrlAdd = useCallback(async (url: string) => {
    if (imageCount >= 10) return;
    setSaving(true);
    try {
      const endpoint = entityType === 'product'
        ? `/api/studio/products/${entityId}/images`
        : entityType === 'persona'
        ? `/api/studio/personas/${entityId}/images`
        : `/api/studio/styles/${entityId}/images`;
      await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      await fetchEntity();
    } finally {
      setSaving(false);
    }
  }, [entityId, entityType, imageCount, fetchEntity]);

  const getImageUrl = (imageId: string) => {
    return entityType === 'product'
      ? `/api/studio/products/${entityId}/images/${imageId}`
      : entityType === 'persona'
      ? `/api/studio/personas/${entityId}/images/${imageId}`
      : `/api/studio/styles/${entityId}/images/${imageId}`;
  };

  if (loading) {
    return <div className="flex items-center justify-center py-16"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
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
            <Button size="sm" variant="outline" onClick={() => setShowPicker(true)} className="gap-1">
              <Plus className="h-3 w-3" />
              {t('modelDetail.addImages')}
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
          {images.map((img: StudioProductImage | StudioPersonaImage | StudioStyleImage) => (
            <div key={img.id} className="group relative aspect-square overflow-hidden rounded-md border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={getImageUrl(img.id)} alt={img.fileName} className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-end justify-center gap-1 bg-black/50 opacity-0 transition-opacity group-hover:opacity-100 pb-2">
                <Button size="sm" variant="destructive" className="h-7 text-xs" onClick={() => handleDeleteImage(img.id)}>
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
        onUrlAdd={handlePickerUrlAdd}
      />
    </div>
  );
}
