import { cn } from '@/lib/utils';
import type { StudioPreset } from '../../types/presets';
import {
  Camera,
  Package,
  UtensilsCrossed,
  Sun,
  Sparkles,
  Cpu,
  Home,
  Car,
  Layers,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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

interface PresetCardProps {
  preset: StudioPreset;
  onClick?: () => void;
}

export function PresetCard({ preset, onClick }: PresetCardProps) {
  const CategoryIcon = CATEGORY_ICONS[preset.category ?? ''] ?? Layers;
  const gradient = CATEGORY_GRADIENTS[preset.category ?? ''] ?? 'from-muted to-muted/50';
  const iconColor = CATEGORY_ICON_COLORS[preset.category ?? ''] ?? 'text-muted-foreground/40';

  return (
    <div
      onClick={onClick}
      className={cn(
        'group cursor-pointer rounded-xl border border-border bg-card p-3 transition-all hover:border-primary/50 hover:shadow-md',
        'flex flex-col gap-2',
      )}
    >
      <div className="relative aspect-square overflow-hidden rounded-lg bg-muted">
        {preset.previewImageUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preset.previewImageUrl}
              alt={preset.name}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          </>
        ) : (
          <div className={cn('flex h-full w-full flex-col items-center justify-center gap-2 bg-gradient-to-br', gradient)}>
            <CategoryIcon className={cn('h-10 w-10', iconColor)} />
            <span className="max-w-[80%] text-center text-xs font-medium leading-tight text-muted-foreground/50 line-clamp-2">
              {preset.name}
            </span>
          </div>
        )}
        {preset.isDefault && (
          <div className="absolute left-2 top-2 rounded-full bg-primary/90 px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
            Default
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <p className="line-clamp-1 text-sm font-medium">{preset.name}</p>
        {preset.category && (
          <div className="flex items-center gap-1">
            <Layers className="h-3 w-3 text-muted-foreground" />
            <span className="text-xs capitalize text-muted-foreground">{preset.category}</span>
          </div>
        )}
        {preset.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {preset.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
            {preset.tags.length > 3 && (
              <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                +{preset.tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}