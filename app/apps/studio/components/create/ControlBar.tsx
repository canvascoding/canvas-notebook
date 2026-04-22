'use client';

import { ChevronDown, Settings2, Sparkles } from 'lucide-react';
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
import { AspectRatioPicker } from './AspectRatioPicker';
import {
  PROVIDERS,
  OPENAI_MODELS,
  QUALITY_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  BACKGROUND_OPTIONS,
  VIDEO_PROVIDERS,
  VIDEO_MODELS,
  VIDEO_DURATIONS,
  getModelsForProvider,
  getAspectRatiosForProvider,
  getVideoResolutionsForModel,
  getVideoDurationsForModel,
  type VideoResolution,
  type VideoDuration,
} from '@/app/lib/integrations/image-generation-constants';

const IMAGE_COUNTS = [1, 2, 3, 4] as const;

const VIDEO_DURATION_OPTIONS = VIDEO_DURATIONS;

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
  provider: string;
  onProviderChange: (value: string) => void;
  model: string;
  onModelChange: (value: string) => void;
  quality: 'low' | 'medium' | 'high' | 'auto';
  onQualityChange: (value: 'low' | 'medium' | 'high' | 'auto') => void;
  outputFormat: 'png' | 'jpeg' | 'webp';
  onOutputFormatChange: (value: 'png' | 'jpeg' | 'webp') => void;
  background: 'transparent' | 'opaque' | 'auto';
  onBackgroundChange: (value: 'transparent' | 'opaque' | 'auto') => void;
  videoResolution: VideoResolution;
  onVideoResolutionChange: (value: VideoResolution) => void;
  videoDuration: VideoDuration;
  onVideoDurationChange: (value: VideoDuration) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  canGenerate: boolean;
  showMoreOptions: boolean;
  onShowMoreOptionsChange: (value: boolean) => void;
}

const MODEL_LABELS: Record<string, string> = {};
for (const m of VIDEO_MODELS) {
  switch (m.optionKey) {
    case 'highQuality': MODEL_LABELS[m.id] = 'Veo 3.1 — Best Quality'; break;
    case 'fast': MODEL_LABELS[m.id] = 'Veo 3.1 Fast — Fast & Affordable'; break;
    case 'lite': MODEL_LABELS[m.id] = 'Veo 3.1 Lite — Budget'; break;
    case 'veo3': MODEL_LABELS[m.id] = 'Veo 3 — Stable'; break;
    case 'veo3Fast': MODEL_LABELS[m.id] = 'Veo 3 Fast — Stable'; break;
    case 'veo2': MODEL_LABELS[m.id] = 'Veo 2 — Legacy (No Audio)'; break;
  }
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
  provider,
  onProviderChange,
  model,
  onModelChange,
  quality,
  onQualityChange,
  outputFormat,
  onOutputFormatChange,
  background,
  onBackgroundChange,
  videoResolution,
  onVideoResolutionChange,
  videoDuration,
  onVideoDurationChange,
  onGenerate,
  isGenerating,
  canGenerate,
  showMoreOptions,
  onShowMoreOptionsChange,
}: ControlBarProps) {
  const countLabel = mode === 'video' ? '1 output' : `${count} output${count === 1 ? '' : 's'}`;
  const models = getModelsForProvider(mode, provider);
  const aspectRatios = getAspectRatiosForProvider(mode, provider);
  const isOpenAI = provider === 'openai';
  const isVideo = mode === 'video';

  const videoResolutions = isVideo ? getVideoResolutionsForModel(model) : [];
  const videoDurations = isVideo ? getVideoDurationsForModel(model) : [];
  const durationLocked = videoResolution === '1080p' || videoResolution === '4k';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 rounded-[24px] border border-border/70 bg-card/90 px-4 py-3 shadow-sm">
        <ModeToggle value={mode} onChange={onModeChange} />
        <StudioPicker presets={presets} value={selectedPreset} onChange={onPresetChange} />

        <AspectRatioPicker
          aspectRatio={aspectRatio}
          onAspectRatioChange={onAspectRatioChange}
          aspectRatios={aspectRatios}
          isOpenAI={isOpenAI}
        />

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

        {isVideo && (
          <>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="rounded-full">
                  {videoResolution}
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                {videoResolutions.map((r) => (
                  <DropdownMenuItem key={r} onSelect={() => onVideoResolutionChange(r)}>
                    {r}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="rounded-full" disabled={durationLocked}>
                  {videoDuration}s
                  <ChevronDown className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                {(durationLocked ? [8 as VideoDuration] : VIDEO_DURATION_OPTIONS.filter((d) => videoDurations.includes(d))).map((d) => (
                  <DropdownMenuItem key={d} onSelect={() => onVideoDurationChange(d as VideoDuration)}>
                    {d}s
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant={showMoreOptions ? 'default' : 'outline'}
            size="sm"
            className="rounded-full"
            onClick={() => onShowMoreOptionsChange(!showMoreOptions)}
          >
            <Settings2 className="h-4 w-4" />
            {showMoreOptions ? 'Less Options' : 'More Options'}
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

      {showMoreOptions && (
        <div className="rounded-[24px] border border-border/70 bg-card/90 px-4 py-3 shadow-sm">
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Provider</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={provider}
                onChange={(event) => onProviderChange(event.target.value)}
              >
                {(mode === 'video' ? VIDEO_PROVIDERS : PROVIDERS).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id === 'gemini' ? 'Google Gemini' : p.id === 'openai' ? 'OpenAI' : 'Google Veo'}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Model</span>
              <select
                className="h-9 border border-input bg-background px-2 text-sm"
                value={model}
                onChange={(event) => onModelChange(event.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {isVideo
                      ? (MODEL_LABELS[m.id] || m.id)
                      : provider === 'openai'
                        ? OPENAI_MODELS.find((om) => om.id === m.id)?.optionKey === 'gptImage2'
                          ? 'GPT Image 2 — Best Quality'
                          : OPENAI_MODELS.find((om) => om.id === m.id)?.optionKey === 'gptImage15'
                            ? 'GPT Image 1.5 — Best Quality'
                            : OPENAI_MODELS.find((om) => om.id === m.id)?.optionKey === 'gptImage1'
                              ? 'GPT Image 1 — High Quality'
                              : 'GPT Image 1 Mini — Fast & Affordable'
                        : m.id === 'gemini-3.1-flash-image-preview'
                          ? 'Gemini 3.1 Flash — Best Quality & Features'
                          : 'Gemini 2.5 Flash — Fast & Affordable'}
                  </option>
                ))}
              </select>
            </label>

            {isOpenAI && mode === 'image' ? (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">Quality</span>
                  <select
                    className="h-9 border border-input bg-background px-2 text-sm"
                    value={quality}
                    onChange={(event) => onQualityChange(event.target.value as typeof quality)}
                  >
                    {QUALITY_OPTIONS.map((q) => (
                      <option key={q} value={q}>
                        {q.charAt(0).toUpperCase() + q.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="text-xs text-muted-foreground">Output Format</span>
                  <select
                    className="h-9 border border-input bg-background px-2 text-sm"
                    value={outputFormat}
                    onChange={(event) => onOutputFormatChange(event.target.value as typeof outputFormat)}
                  >
                    {OUTPUT_FORMAT_OPTIONS.map((fmt) => (
                      <option key={fmt} value={fmt}>
                        {fmt.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}

            {isOpenAI && mode === 'image' ? (
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs text-muted-foreground">Background</span>
                <select
                  className="h-9 border border-input bg-background px-2 text-sm"
                  value={background}
                  onChange={(event) => onBackgroundChange(event.target.value as typeof background)}
                >
                  {BACKGROUND_OPTIONS.map((bg) => (
                    <option key={bg} value={bg}>
                      {bg.charAt(0).toUpperCase() + bg.slice(1)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}