'use client';

import { useTranslations } from 'next-intl';
import { Boxes } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { StudioProduct, StudioPersona } from '../../types/models';
import type { StudioPreset } from '../../types/presets';

export interface LineItemOverride {
  productId: string;
  productName: string;
  presetId?: string;
  personaId?: string;
  customPrompt?: string;
}

interface BulkLineItemTableProps {
  products: StudioProduct[];
  personas: StudioPersona[];
  presets: StudioPreset[];
  overrides: LineItemOverride[];
  onOverridesChange: (overrides: LineItemOverride[]) => void;
  batchPresetId?: string;
}

export function BulkLineItemTable({
  products,
  personas,
  presets,
  overrides,
  onOverridesChange,
  batchPresetId,
}: BulkLineItemTableProps) {
  const t = useTranslations('studio.bulk');

  const updateOverride = (productId: string, field: keyof LineItemOverride, value: string) => {
    onOverridesChange(
      overrides.map((o) => (o.productId === productId ? { ...o, [field]: value } : o)),
    );
  };

  if (overrides.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <Boxes className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-muted-foreground">
          {t('lineItemsEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('lineItemsProduct')}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('lineItemsPreset')}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('lineItemsPersona')}
            </th>
            <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('lineItemsCustomPrompt')}
            </th>
          </tr>
        </thead>
        <tbody>
          {overrides.map((item) => {
            const product = products.find((p) => p.id === item.productId);
            return (
              <tr key={item.productId} className="border-b border-border/50 last:border-b-0">
                <td className="px-3 py-2">
                  <span className="font-medium">{item.productName}</span>
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({product?.imageCount ?? 0} img)
                  </span>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={item.presetId ?? ''}
                    onChange={(e) => updateOverride(item.productId, 'presetId', e.target.value)}
                    className="h-9 w-full min-w-[120px] rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">{batchPresetId ? t('lineItemsBatch') : '\u2014'}</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <select
                    value={item.personaId ?? ''}
                    onChange={(e) => updateOverride(item.productId, 'personaId', e.target.value)}
                    className="h-9 w-full min-w-[120px] rounded-md border border-input bg-background px-2 text-xs"
                  >
                    <option value="">\u2014</option>
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                </td>
                <td className="px-3 py-2">
                  <Input
                    type="text"
                    placeholder={item.customPrompt ? '' : '\u2014'}
                    value={item.customPrompt ?? ''}
                    onChange={(e) => updateOverride(item.productId, 'customPrompt', e.target.value)}
                    className="h-9 w-full text-xs"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
