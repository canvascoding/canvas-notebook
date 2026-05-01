'use client';

import { useTranslations } from 'next-intl';
import { useState, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, X } from 'lucide-react';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioStyles } from '../../hooks/useStudioStyles';
import { ReferencePickerDialog } from '../create/ReferencePickerDialog';
import { toMediaUrl } from '@/app/lib/utils/media-url';
import type { StudioReferenceUrl } from '../../types/generation';

type EntityType = 'product' | 'persona' | 'style';

interface PendingImage {
  id: string;
  file: File;
  preview: string;
}

interface PendingReferenceUrl extends StudioReferenceUrl {
  id: string;
}

interface ModelCreateDialogProps {
  entityType?: EntityType;
}

function ReferenceUrlChip({
  reference,
  onRemove,
}: {
  reference: PendingReferenceUrl;
  onRemove: () => void;
}) {
  if (reference.status === 'loading') {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-muted text-muted-foreground">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="max-w-[150px] truncate">{reference.originalUrl}</span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  if (reference.status === 'error') {
    return (
      <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300">
        <div className="h-8 w-8 rounded bg-red-200 dark:bg-red-800 flex items-center justify-center text-[10px]">!</div>
        <span className="max-w-[150px] truncate" title={reference.errorMessage}>
          {reference.errorMessage || 'Failed'}
        </span>
        <button
          type="button"
          onClick={onRemove}
          className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-2 rounded-lg px-2 py-1 text-xs bg-muted text-foreground">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={reference.localUrl}
        alt=""
        className="h-8 w-8 rounded object-cover"
        loading="lazy"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      <span className="max-w-[150px] truncate">{reference.originalUrl}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

export function ModelCreateDialog({ entityType = 'product' }: ModelCreateDialogProps) {
  const t = useTranslations('studio');
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [pendingReferenceUrls, setPendingReferenceUrls] = useState<PendingReferenceUrl[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const stylesHook = useStudioStyles();

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const totalImageCount = pendingImages.length + pendingReferenceUrls.filter((r) => r.status === 'success').length;

  const _handleAddReferenceUrl = useCallback(async (url: string) => {
    const id = crypto.randomUUID();
    const tempItem: PendingReferenceUrl = {
      id,
      localUrl: url,
      originalUrl: url,
      status: 'loading',
    };
    setPendingReferenceUrls((current) => [...current, tempItem]);

    try {
      const response = await fetch('/api/studio/references', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to download image');
      }
      setPendingReferenceUrls((current) =>
        current.map((item) =>
          item.id === id ? { ...item, localUrl: data.localUrl, status: 'success' } : item,
        ),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to download image';
      setPendingReferenceUrls((current) =>
        current.map((item) =>
          item.id === id ? { ...item, status: 'error', errorMessage } : item,
        ),
      );
    }
  }, []);

  const handleRemoveReferenceUrl = useCallback((id: string) => {
    setPendingReferenceUrls((current) => current.filter((item) => item.id !== id));
  }, []);

  const handlePickerConfirm = useCallback(async (paths: string[]) => {
    const remainingSlots = 10 - totalImageCount;
    const toAdd = paths.slice(0, remainingSlots);
    if (toAdd.length === 0) return;

    const newImages: PendingImage[] = [];
    for (const path of toAdd) {
      try {
        const res = await fetch(toMediaUrl(path));
        if (!res.ok) continue;
        const blob = await res.blob();
        const fileName = path.split('/').pop() || 'image.jpg';
        const file = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
        newImages.push({
          id: crypto.randomUUID(),
          file,
          preview: URL.createObjectURL(blob),
        });
      } catch {
        // skip failed downloads
      }
    }

    setPendingImages((prev) => [...prev, ...newImages].slice(0, 10));
  }, [totalImageCount]);

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      setError(t('modelCreate.nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let entityId: string | null = null;
      if (entityType === 'product') {
        const product = await productsHook.createProduct({ name: name.trim(), description: description.trim() || undefined });
        entityId = product?.id ?? null;
      } else if (entityType === 'persona') {
        const persona = await personasHook.createPersona({ name: name.trim(), description: description.trim() || undefined });
        entityId = persona?.id ?? null;
      } else {
        const style = await stylesHook.createStyle({ name: name.trim(), description: description.trim() || undefined });
        entityId = style?.id ?? null;
      }

      if (!entityId) {
        setError(t('modelCreate.createFailed'));
        return;
      }

      for (const img of pendingImages) {
        if (entityType === 'product') {
          await productsHook.addImage(entityId, img.file);
        } else if (entityType === 'persona') {
          await personasHook.addImage(entityId, img.file);
        } else {
          await stylesHook.addImage(entityId, img.file);
        }
      }

      for (const ref of pendingReferenceUrls) {
        if (ref.status !== 'success') continue;
        if (entityType === 'product') {
          await productsHook.addImageFromUrl(entityId, ref.originalUrl);
        } else if (entityType === 'persona') {
          await personasHook.addImageFromUrl(entityId, ref.originalUrl);
        } else {
          await stylesHook.addImageFromUrl(entityId, ref.originalUrl);
        }
      }

      router.push(`/studio/models/${entityId}?type=${entityType}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [name, description, entityType, pendingImages, pendingReferenceUrls, productsHook, personasHook, stylesHook, router, t]);

  const canSave = name.trim().length > 0 && !saving;

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-10">
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('modelCreate.name')}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={entityType === 'product' ? t('modelCreate.productNamePlaceholder') : entityType === 'persona' ? t('modelCreate.personaNamePlaceholder') : t('modelCreate.styleNamePlaceholder')}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('modelCreate.description')}</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('modelCreate.descriptionPlaceholder')}
          rows={3}
          className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">{t('modelCreate.images')}</label>
          {totalImageCount < 10 && (
            <Button size="sm" variant="outline" onClick={() => setShowPicker(true)} className="gap-1">
              <Plus className="h-3 w-3" />
              {t('modelCreate.addImages')}
            </Button>
          )}
        </div>
        {totalImageCount === 0 ? (
          <p className="text-sm text-muted-foreground">{t('modelCreate.noImages')}</p>
        ) : (
          <div className="grid grid-cols-5 gap-2">
            {pendingImages.map((img) => (
              <div key={img.id} className="group relative aspect-square overflow-hidden rounded-md border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt="" className="h-full w-full object-cover" />
                <button
                  type="button"
                  onClick={() => handleRemoveImage(img.id)}
                  className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {pendingReferenceUrls.filter((r) => r.status === 'success').map((ref) => (
              <div key={ref.id} className="group relative aspect-square overflow-hidden rounded-md border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={ref.localUrl} alt="" className="h-full w-full object-cover" loading="lazy" />
              </div>
            ))}
          </div>
        )}
        {pendingReferenceUrls.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingReferenceUrls.map((ref) => (
              <ReferenceUrlChip
                key={ref.id}
                reference={ref}
                onRemove={() => handleRemoveReferenceUrl(ref.id)}
              />
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button onClick={handleSave} disabled={!canSave} className="w-full">
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('modelCreate.save')}
      </Button>

      <ReferencePickerDialog
        open={showPicker}
        onOpenChange={setShowPicker}
        onConfirm={handlePickerConfirm}
      />
    </div>
  );
}
