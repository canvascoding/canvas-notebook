import { cn } from '@/lib/utils';
import type { StudioPreset } from '../../types/presets';
import { Layers, Sparkles } from 'lucide-react';

interface PresetCardProps {
  preset: StudioPreset;
  onClick?: () => void;
}

export function PresetCard({ preset, onClick }: PresetCardProps) {
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
          <img
            src={preset.previewImageUrl}
            alt={preset.name}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/50" />
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
