'use client';

import { useState, useMemo } from 'react';
import { Check, Camera, Package, UtensilsCrossed, Sun, Sparkles, Cpu, Home, Car, Layers, LayoutTemplate, Search, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import type { StudioPreset } from '../../types/presets';

const CATEGORY_ICONS: Record<string, LucideIcon> = {
  fashion: Camera,
  product: Package,
  food: UtensilsCrossed,
  lifestyle: Sun,
  beauty: Sparkles,
  tech: Cpu,
  interior: Home,
  automotive: Car,
};

const CATEGORY_GRADIENTS: Record<string, string> = {
  fashion: 'from-rose-100 to-pink-50',
  product: 'from-slate-100 to-gray-50',
  food: 'from-amber-100 to-yellow-50',
  lifestyle: 'from-orange-100 to-amber-50',
  beauty: 'from-fuchsia-100 to-pink-50',
  tech: 'from-blue-100 to-cyan-50',
  interior: 'from-stone-100 to-neutral-50',
  automotive: 'from-zinc-200 to-zinc-100',
};

const CATEGORY_ICON_COLORS: Record<string, string> = {
  fashion: 'text-rose-400/60',
  product: 'text-slate-400/60',
  food: 'text-amber-400/60',
  lifestyle: 'text-orange-400/60',
  beauty: 'text-fuchsia-400/60',
  tech: 'text-blue-400/60',
  interior: 'text-stone-400/60',
  automotive: 'text-zinc-500/60',
};

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

function PresetHoverPreview({ preset }: { preset: StudioPreset }) {
  const CategoryIcon = CATEGORY_ICONS[preset.category ?? ''] ?? Layers;
  const gradient = CATEGORY_GRADIENTS[preset.category ?? ''] ?? 'from-muted to-muted/50';
  const iconColor = CATEGORY_ICON_COLORS[preset.category ?? ''] ?? 'text-muted-foreground/40';

  return (
    <div className="space-y-2">
      <div className="relative aspect-square w-full overflow-hidden rounded-lg bg-muted">
        {preset.previewImagePath ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={toPreviewUrl(preset.previewImagePath, 480)}
            alt={preset.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className={cn('flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br', gradient)}>
            <CategoryIcon className={cn('h-10 w-10', iconColor)} />
            <span className="max-w-[80%] text-center text-xs font-medium leading-tight text-muted-foreground/50 line-clamp-2">
              {preset.name}
            </span>
          </div>
        )}
      </div>
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{preset.name}</p>
        {preset.description ? (
          <p className="line-clamp-2 text-xs text-muted-foreground">{preset.description}</p>
        ) : null}
        {preset.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {preset.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
            {preset.tags.length > 3 && (
              <span className="inline-flex items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                +{preset.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PresetMenuItem({
  preset,
  isSelected,
  isActive,
  onSelect,
  onActivate,
}: {
  preset: StudioPreset;
  isSelected: boolean;
  isActive: boolean;
  onSelect: () => void;
  onActivate: (active: boolean) => void;
}) {
  return (
    <HoverCard openDelay={300} closeDelay={100} open={isActive} onOpenChange={onActivate}>
      <HoverCardTrigger asChild>
        <DropdownMenuItem onSelect={onSelect}>
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
            {isSelected ? <Check className="h-4 w-4 shrink-0" /> : null}
          </div>
        </DropdownMenuItem>
      </HoverCardTrigger>
      <HoverCardContent side="right" align="start" className="w-56 p-3">
        <PresetHoverPreview preset={preset} />
      </HoverCardContent>
    </HoverCard>
  );
}

export function StudioPicker({ presets, value, onChange }: StudioPickerProps) {
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredPresets = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return presets;
    return presets.filter((p) => {
      if (p.name.toLowerCase().includes(q)) return true;
      if (p.description?.toLowerCase().includes(q)) return true;
      if (p.category?.toLowerCase().includes(q)) return true;
      if (p.tags?.some((t) => t.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [presets, searchQuery]);

  if (presets.length === 0) {
    return null;
  }

  const groups = groupPresetsByCategory(filteredPresets);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="rounded-full">
          <LayoutTemplate className="h-4 w-4" />
          {value ? value.name : 'Preset'}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 w-72">
        <div className="px-1 pb-1">
          <div className="relative flex items-center">
            <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Search presets..."
              className="h-8 w-full rounded-md border border-input bg-background pl-7 pr-7 text-sm outline-none focus:ring-2 focus:ring-ring/20"
              autoFocus
            />
            {searchQuery ? (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>
        <DropdownMenuItem onSelect={() => onChange(null)}>
          <span className="flex flex-1 items-center justify-between">
            <span>No preset</span>
            {!value ? <Check className="h-4 w-4" /> : null}
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {groups.length === 0 ? (
          <div className="px-2 py-4 text-center text-sm text-muted-foreground">
            No presets found.
          </div>
        ) : (
          groups.map(([category, categoryPresets], groupIndex) => (
            <div key={category}>
              <DropdownMenuLabel className="capitalize">{category}</DropdownMenuLabel>
              {categoryPresets.map((preset) => (
                <PresetMenuItem
                  key={preset.id}
                  preset={preset}
                  isSelected={value?.id === preset.id}
                  isActive={activePresetId === preset.id}
                  onSelect={() => onChange(preset)}
                  onActivate={(active) => setActivePresetId(active ? preset.id : null)}
                />
              ))}
              {groupIndex < groups.length - 1 ? <DropdownMenuSeparator /> : null}
            </div>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}