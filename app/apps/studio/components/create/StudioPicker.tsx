'use client';

import { Check, LayoutTemplate } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import type { StudioPreset } from '../../types/presets';

interface StudioPickerProps {
  presets: StudioPreset[];
  value: StudioPreset | null;
  onChange: (preset: StudioPreset | null) => void;
}

function groupPresetsByCategory(presets: StudioPreset[]) {
  const groups = new Map<string, StudioPreset[]>();

  for (const preset of presets) {
    const key = preset.category || 'uncategorized';
    const current = groups.get(key) || [];
    current.push(preset);
    groups.set(key, current);
  }

  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

export function StudioPicker({ presets, value, onChange }: StudioPickerProps) {
  if (presets.length === 0) {
    return null;
  }

  const groups = groupPresetsByCategory(presets);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <LayoutTemplate className="h-4 w-4" />
          {value ? value.name : 'Preset'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72">
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex flex-1 items-center justify-between">
            <span>No preset</span>
            {!value ? <Check className="h-4 w-4" /> : null}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {groups.map(([category, categoryPresets], groupIndex) => (
          <div key={category}>
            <DropdownMenuLabel className="capitalize">{category}</DropdownMenuLabel>
            {categoryPresets.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => onChange(preset)}>
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  {preset.previewImagePath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={toPreviewUrl(preset.previewImagePath, 64, { preset: 'mini' })} alt="" className="h-8 w-8 rounded-md object-cover shrink-0" />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 shrink-0">
                      <LayoutTemplate className="h-4 w-4 text-primary" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{preset.name}</div>
                    {preset.description ? (
                      <div className="truncate text-xs text-muted-foreground">{preset.description}</div>
                    ) : null}
                  </div>
                  {value?.id === preset.id ? <Check className="h-4 w-4 shrink-0" /> : null}
                </div>
              </DropdownMenuItem>
            ))}
            {groupIndex < groups.length - 1 ? <DropdownMenuSeparator /> : null}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
