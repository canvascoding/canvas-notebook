'use client';

import { useTranslations } from 'next-intl';
import { useState, useCallback } from 'react';
import { useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Link as LinkIcon, Loader2 } from 'lucide-react';
import { ImageUploadArea } from '../shared/ImageUploadArea';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useImagePreprocess } from '@/app/hooks/useImagePreprocess';
import { ImagePreprocessDialog } from '@/app/components/shared/ImagePreprocessDialog';

type EntityType = 'product' | 'persona';

interface PendingImage {
  id: string;
  file: File;
  preview: string;
}

interface ModelCreateDialogProps {
  entityType?: EntityType;
}

export function ModelCreateDialog({ entityType = 'product' }: ModelCreateDialogProps) {
  const t = useTranslations('studio');
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();

  const handleUpload = useCallback(async (files: File[]) => {
    const newImages: PendingImage[] = files.map((file) => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
    }));
    setPendingImages((prev) => [...prev, ...newImages].slice(0, 10));
  }, []);

  const { handleFiles, dialogState, setDialogState, handleConfirm, handleSkip, isProcessing } =
    useImagePreprocess({
      onUpload: handleUpload,
    });

  const handleRemoveImage = useCallback((id: string) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((i) => i.id !== id);
    });
  }, []);

  const handleReorderImages = useCallback((fromIndex: number, toIndex: number) => {
    setPendingImages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }, []);

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
      } else {
        const persona = await personasHook.createPersona({ name: name.trim(), description: description.trim() || undefined });
        entityId = persona?.id ?? null;
      }

      if (!entityId) {
        setError(t('modelCreate.createFailed'));
        return;
      }

      for (const img of pendingImages) {
        if (entityType === 'product') {
          await productsHook.addImage(entityId, img.file);
        } else {
          await personasHook.addImage(entityId, img.file);
        }
      }

      router.push(`/studio/models/${entityId}?type=${entityType}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setSaving(false);
    }
  }, [name, description, entityType, pendingImages, productsHook, personasHook, router, t]);

  const canSave = name.trim().length > 0 && !saving;

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-10">
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('modelCreate.name')}</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={entityType === 'product' ? t('modelCreate.productNamePlaceholder') : t('modelCreate.personaNamePlaceholder')}
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
        <label className="text-sm font-medium">{t('modelCreate.images')}</label>
        <ImageUploadArea
          maxImages={10}
          onFilesSelected={handleFiles}
          pendingImages={pendingImages}
          onRemoveImage={handleRemoveImage}
          onReorderImages={handleReorderImages}
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('modelCreate.urlImport')}</label>
        <div className="flex gap-2">
          <Input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={t('modelCreate.urlPlaceholder')}
            className="flex-1"
          />
          <Button variant="outline" size="sm" disabled={!urlInput.trim()}>
            <LinkIcon className="mr-2 h-4 w-4" />
            {t('modelCreate.addUrl')}
          </Button>
        </div>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button onClick={handleSave} disabled={!canSave} className="w-full">
        {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {t('modelCreate.save')}
      </Button>

      {dialogState && (
        <ImagePreprocessDialog
          open={!!dialogState}
          onOpenChange={(open) => { if (!open) setDialogState(null); }}
          files={dialogState.files}
          onConfirm={handleConfirm}
          onSkip={handleSkip}
        />
      )}
    </div>
  );
}