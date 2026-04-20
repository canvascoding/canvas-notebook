'use client';

import { ChevronDown, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import type { StudioGenerationMode } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { ModeToggle } from './ModeToggle';
import { StudioPicker } from './StudioPicker';

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4'] as const;
const IMAGE_COUNTS = [1, 2, 3, 4] as const;

interface ControlBarProps {
  mode: StudioGenerationMode;
  onModeChange: (value: StudioGenerationMode) => void;
  presets: StudioPreset[];
  selectedPreset: StudioPreset | null;
  onPresetChange: (preset: StudioPreset | null) => void;
  aspectRatio: string;
  onAspectRatioChange: (value: string) => void;
  count: number;
  onCountChange: (value: number) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  canGenerate: boolean;
}

export function ControlBar({
  mode,
  onModeChange,
  presets,
  selectedPreset,
  onPresetChange,
  aspectRatio,
  onAspectRatioChange,
  count,
  onCountChange,
  onGenerate,
  isGenerating,
  canGenerate,
}: ControlBarProps) {
  const countLabel = mode === 'video' ? '1 output' : `${count} output${count === 1 ? '' : 's'}`;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[24px] border border-border/70 bg-card/90 px-4 py-3 shadow-sm">
      <ModeToggle value={mode} onChange={onModeChange} />
      <StudioPicker presets={presets} value={selectedPreset} onChange={onPresetChange} />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="rounded-full">
            AR {aspectRatio}
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {ASPECT_RATIOS.map((ratio) => (
            <DropdownMenuItem key={ratio} onSelect={() => onAspectRatioChange(ratio)}>
              {ratio}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="rounded-full">
            {countLabel}
            <ChevronDown className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-40">
          {(mode === 'video' ? [1] : IMAGE_COUNTS).map((option) => (
            <DropdownMenuItem key={option} onSelect={() => onCountChange(option)}>
              {option} output{option === 1 ? '' : 's'}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto flex gap-2">
        <Button type="button" variant="outline" size="sm" disabled>
          More Options
        </Button>
        <Button
          type="button"
          size="sm"
          className="rounded-full px-4"
          onClick={onGenerate}
          disabled={isGenerating || !canGenerate}
        >
          <Sparkles className="h-4 w-4" />
          {isGenerating ? 'Generating...' : 'Generate'}
        </Button>
      </div>
    </div>
  );
}
