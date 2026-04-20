'use client';

import { useEffect, useMemo, useState } from 'react';
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

  useEffect(() => {
    const filtered = selectedProductIds.map((id) => {
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
    setOverrides(filtered);
  }, [selectedProductIds, products]);

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
      line_item_overrides: overrides
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
    <div className="flex h-full flex-col gap-6 overflow-y-auto pb-8">
      <div>
        <h2 className="mb-1 text-lg font-semibold">Bulk Generate</h2>
        <p className="text-sm text-muted-foreground">
          Apply a studio preset to multiple products at once with per-item overrides.
        </p>
      </div>

      {hasActiveJob && (
        <div className="rounded-lg border border-border p-4">
          <BulkProgressTracker
            job={activeJob}
            onCancel={() => cancelJob(activeJob.id)}
          />
        </div>
      )}

      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">Product Selection</h3>
        <ProductCatalogList
          products={products}
          selectedIds={hasActiveJob ? [] : selectedProductIds}
          onSelectionChange={hasActiveJob ? () => {} : setSelectedProductIds}
          loading={productsHook.loading}
        />
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">Batch Settings</h3>
        <div className="space-y-3">
          <Input
            placeholder="Prompt applied to all products..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!!hasActiveJob}
          />
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Studio</label>
              <select
                value={presetId}
                onChange={(e) => setPresetId(e.target.value)}
                disabled={!!hasActiveJob}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                <option value="">None</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">AR</label>
              <select
                value={aspectRatio}
                onChange={(e) => setAspectRatio(e.target.value)}
                disabled={!!hasActiveJob}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                {ASPECT_RATIOS.map((ar) => (
                  <option key={ar} value={ar}>{ar}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-muted-foreground">Versions</label>
              <select
                value={versions}
                onChange={(e) => setVersions(Number(e.target.value))}
                disabled={!!hasActiveJob}
                className="h-8 rounded-md border border-input bg-background px-2 text-xs"
              >
                {VERSIONS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border p-4">
        <h3 className="mb-3 text-sm font-semibold">Line Items (Per-Item Overrides)</h3>
        <BulkLineItemTable
          products={products}
          personas={personas}
          presets={presets}
          overrides={overrides}
          onOverridesChange={setOverrides}
          batchPresetId={presetId || undefined}
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="rounded-full">
            {selectedProductIds.length} products x {versions} versions = {totalGenerations} generations
          </Badge>
        </div>
        <Button
          onClick={handleStart}
          disabled={!canStart || !!hasActiveJob}
        >
          Start Bulk Generation
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}
    </div>
  );
}