'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useStudioBulk } from '../../hooks/useStudioBulk';
import { useStudioProducts } from '../../hooks/useStudioProducts';
import { useStudioPersonas } from '../../hooks/useStudioPersonas';
import { useStudioPresets } from '../../hooks/useStudioPresets';
import { ProductCatalogList } from './ProductCatalogList';
import { BulkLineItemTable, type LineItemOverride } from './BulkLineItemTable';
import { BulkProgressTracker } from './BulkProgressTracker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { StudioBulkCreatePayload } from '../../types/bulk';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const VERSIONS = [1, 2, 3, 4] as const;

export function BulkGenerateView() {
  const t = useTranslations('studio.bulk');
  const bulkHook = useStudioBulk();
  const productsHook = useStudioProducts();
  const personasHook = useStudioPersonas();
  const presetsHook = useStudioPresets();

  const { fetchProducts, products } = productsHook;
  const { fetchPersonas, personas } = personasHook;
  const { fetchPresets, presets } = presetsHook;
  const { createJob, cancelJob, activeJob, loading, error } = bulkHook;

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [presetId, setPresetId] = useState<string>('');
  const [aspectRatio, setAspectRatio] = useState<string>('1:1');
  const [versions, setVersions] = useState<number>(1);
  const [overrides, setOverrides] = useState<LineItemOverride[]>([]);

  useEffect(() => {
    void fetchProducts();
    void fetchPersonas();
    void fetchPresets();
  }, [fetchProducts, fetchPersonas, fetchPresets]);

  const derivedOverrides = selectedProductIds.map((id) => {
    const product = products.find((p) => p.id === id);
    const existing = overrides.find((o) => o.productId === id);
    return {
      productId: id,
      productName: product?.name ?? 'Unknown',
      presetId: existing?.presetId,
      personaId: existing?.personaId,
      customPrompt: existing?.customPrompt,
    };
  });

  const effectiveOverrides = derivedOverrides.map((derived) => {
    const existing = overrides.find((o) => o.productId === derived.productId);
    if (existing) {
      return { ...existing, productName: derived.productName };
    }
    return derived;
  });

  const canStart = useMemo(() => {
    return selectedProductIds.length > 0 && prompt.trim().length > 0 && !loading;
  }, [selectedProductIds, prompt, loading]);

  const totalGenerations = selectedProductIds.length * versions;

  const handleStart = async () => {
    const payload: StudioBulkCreatePayload = {
      product_ids: selectedProductIds,
      prompt: prompt.trim(),
      preset_id: presetId || undefined,
      aspect_ratio: aspectRatio,
      versions_per_product: versions,
      line_item_overrides: effectiveOverrides
        .filter((o) => o.presetId || o.personaId || o.customPrompt)
        .map((o) => ({
          product_id: o.productId,
          preset_id: o.presetId || undefined,
          persona_id: o.personaId || undefined,
          custom_prompt: o.customPrompt || undefined,
        })),
    };

    const job = await createJob(payload);
    if (job) {
      setPrompt('');
    }
  };

  const hasActiveJob = activeJob && (activeJob.status === 'pending' || activeJob.status === 'processing');

  return (
    <div className="flex h-full flex-col gap-8">
      <div className="max-w-2xl space-y-3">
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          {t('title')}
        </h2>
        <p className="max-w-xl text-sm leading-6 text-muted-foreground sm:text-base">
          {t('description')}
        </p>
      </div>

      {hasActiveJob && (
        <div className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
          <BulkProgressTracker
            job={activeJob}
            onCancel={() => cancelJob(activeJob.id)}
          />
        </div>
      )}

      <section className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('productSelection')}
        </h3>
        <ProductCatalogList
          products={products}
          selectedIds={hasActiveJob ? [] : selectedProductIds}
          onSelectionChange={hasActiveJob ? () => {} : (ids) => {
            setSelectedProductIds(ids);
            setOverrides((prev) => prev.filter((o) => ids.includes(o.productId)));
          }}
          loading={productsHook.loading}
        />
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('batchSettings')}
        </h3>
        <div className="space-y-3">
          <Input
            placeholder={t('batchSettingsPrompt')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!!hasActiveJob}
          />
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">{t('presetLabel')}</label>
              <select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                disabled={!!hasActiveJob}
                className="h-9 rounded-md border border-input bg-background px-3 text-xs"
              >
                <option value="">{t('presetNone')}</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">{t('aspectRatioLabel')}</label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                disabled={!!hasActiveJob}
                className="h-9 rounded-md border border-input bg-background px-3 text-xs"
              >
                {ASPECT_RATIOS.map((ar) => (
                  <option key={ar} value={ar}>{ar}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">{t('versionsLabel')}</label>
              <select
                value={versions}
                onChange={(e) => setVersions(Number(e.target.value))}
                disabled={!!hasActiveJob}
                className="h-9 rounded-md border border-input bg-background px-3 text-xs"
              >
                {VERSIONS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border/70 bg-card/80 p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('lineItemsTitle')}
        </h3>
        <BulkLineItemTable
          products={products}
          personas={personas}
          presets={presets}
          overrides={effectiveOverrides}
          onOverridesChange={setOverrides}
          batchPresetId={presetId || undefined}
        />
      </section>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="w-fit rounded-full px-3 py-1 text-xs uppercase tracking-[0.18em]">
            {t('summaryBadge', { products: selectedProductIds.length, versions, total: totalGenerations })}
          </Badge>
        </div>
        <Button
          onClick={handleStart}
          disabled={!canStart || !!hasActiveJob}
        >
          {t('startButton')}
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('errorPrefix')} {error}
        </div>
      )}
    </div>
  );
}
