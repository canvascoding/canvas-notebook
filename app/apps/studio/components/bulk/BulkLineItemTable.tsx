'use client';

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
  const updateOverride = (productId: string, field: keyof LineItemOverride, value: string) => {
    onOverridesChange(
      overrides.map((o) => (o.productId === productId ? { ...o, [field]: value } : o)),
    );
  };

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Product</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Studio</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Persona</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">Custom Prompt</th>
          </tr>
        </thead>
        <tbody>
          {overrides.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                Select products above to configure per-item overrides
              </td>
            </tr>
          ) : (
            overrides.map((item) => {
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
                      className="h-8 w-full min-w-[120px] rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">{batchPresetId ? '\u2014 (batch)' : '\u2014'}</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={item.personaId ?? ''}
                      onChange={(e) => updateOverride(item.productId, 'personaId', e.target.value)}
                      className="h-8 w-full min-w-[120px] rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">\u2014</option>
                      {personas.map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      placeholder={item.customPrompt ? '' : '\u2014'}
                      value={item.customPrompt ?? ''}
                      onChange={(e) => updateOverride(item.productId, 'customPrompt', e.target.value)}
                      className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                    />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}