'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ChevronDown, Settings2, Sparkles } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { StudioGenerationMode } from '../../types/generation';
import type { StudioPreset } from '../../types/presets';
import { ModeToggle } from './ModeToggle';
import { StudioPicker } from './StudioPicker';
import { AspectRatioPicker } from './AspectRatioPicker';
import {
  PROVIDERS,
  QUALITY_OPTIONS,
  OUTPUT_FORMAT_OPTIONS,
  BACKGROUND_OPTIONS,
  VIDEO_PROVIDERS,
  VIDEO_MODELS,
  SEEDANCE_VIDEO_MODELS,
  SOUND_PROVIDERS,
  SOUND_MODELS,
  getModelsForProvider,
  getAspectRatiosForProvider,
  getVideoResolutionsForModel,
  getVideoDurationsForModel,
  getImageSizesForModel,
  GEMINI_FLASH_IMAGE_MODEL_ID,
  GEMINI_PRO_IMAGE_MODEL_ID,
  type VideoResolution,
  type StudioVideoDuration,
} from '@/app/lib/integrations/image-generation-constants';

const IMAGE_COUNTS = [1, 2, 3, 4] as const;

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  disabled?: boolean;
  className?: string;
}

function SelectField({ label, value, onChange, children, disabled, className }: SelectFieldProps) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1 text-sm', className)}>
      <span className="truncate text-[11px] text-muted-foreground sm:text-xs">{label}</span>
      <select
        className="h-8 w-full min-w-0 truncate rounded-lg border border-input bg-background px-2 text-xs sm:h-9 sm:rounded-xl sm:text-sm"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    </label>
  );
}

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
  outputFormat: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav';
  onOutputFormatChange: (value: 'png' | 'jpeg' | 'webp' | 'mp3' | 'wav') => void;
  background: 'transparent' | 'opaque' | 'auto';
  onBackgroundChange: (value: 'transparent' | 'opaque' | 'auto') => void;
  imageSize: string;
  onImageSizeChange: (value: string) => void;
  videoResolution: VideoResolution;
  onVideoResolutionChange: (value: VideoResolution) => void;
  videoDuration: StudioVideoDuration;
  onVideoDurationChange: (value: StudioVideoDuration) => void;
  videoGenerateAudio: boolean;
  onVideoGenerateAudioChange: (value: boolean) => void;
  videoWebSearch: boolean;
  onVideoWebSearchChange: (value: boolean) => void;
  videoNsfwChecker: boolean;
  onVideoNsfwCheckerChange: (value: boolean) => void;
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
  }
}
for (const m of SEEDANCE_VIDEO_MODELS) {
  MODEL_LABELS[m.id] = 'Seedance 2.0 — Bytedance';
}
for (const m of SOUND_MODELS) {
  MODEL_LABELS[m.id] = m.id === 'lyria-3-clip-preview'
    ? 'Lyria 3 Clip — 30s MP3'
    : 'Lyria 3 Pro — Full song';
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
  imageSize,
  onImageSizeChange,
  videoResolution,
  onVideoResolutionChange,
  videoDuration,
  onVideoDurationChange,
  videoGenerateAudio,
  onVideoGenerateAudioChange,
  videoWebSearch,
  onVideoWebSearchChange,
  videoNsfwChecker,
  onVideoNsfwCheckerChange,
  onGenerate,
  isGenerating,
  canGenerate,
  showMoreOptions,
  onShowMoreOptionsChange,
}: ControlBarProps) {
  const t = useTranslations('studio.aspectRatioEditor');
  const countLabel = mode === 'video' || mode === 'sound' ? '1 output' : `${count} output${count === 1 ? '' : 's'}`;
  const models = getModelsForProvider(mode, provider);
  const aspectRatios = getAspectRatiosForProvider(mode, provider);
  const isOpenAI = provider === 'openai';
  const isVideo = mode === 'video';
  const isSound = mode === 'sound';
  const isSeedance = isVideo && provider === 'bytedance';

  const videoResolutions = isVideo ? getVideoResolutionsForModel(model) : [];
  const videoDurations = isVideo ? getVideoDurationsForModel(model) : [];
  const durationLocked = !isSeedance && (videoResolution === '1080p' || videoResolution === '4k');

  const imageSizeLabels: Record<string, string> = {
    '512': t('resolutionVeryLow'),
    '1K': t('resolutionNormal'),
    '2K': t('resolutionHigh'),
    '4K': t('resolutionVeryHigh'),
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2">
        <ModeToggle value={mode} onChange={onModeChange} />
        <StudioPicker presets={presets} value={selectedPreset} onChange={onPresetChange} disabled={isSound} />

        {!isSound ? (
          <AspectRatioPicker
            aspectRatio={aspectRatio}
            onAspectRatioChange={onAspectRatioChange}
            aspectRatios={aspectRatios}
            isOpenAI={isOpenAI}
          />
        ) : null}

        {isVideo || isSound ? (
          <Badge variant="secondary" className="rounded-full px-3 py-1 text-sm">
            1 output
          </Badge>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="rounded-full">
                {countLabel}
                <ChevronDown className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-40">
              {IMAGE_COUNTS.map((option) => (
                <DropdownMenuItem key={option} onSelect={() => onCountChange(option)}>
                  {option} output{option === 1 ? '' : 's'}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

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
                {(durationLocked ? [8 as StudioVideoDuration] : videoDurations).map((d) => (
                  <DropdownMenuItem key={d} onSelect={() => onVideoDurationChange(d as StudioVideoDuration)}>
                    {d}s
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant={showMoreOptions ? 'default' : 'outline'}
            size="sm"
            className="h-8 rounded-full px-2.5"
            onClick={() => onShowMoreOptionsChange(!showMoreOptions)}
          >
            <Settings2 className="h-4 w-4" />
            <span className="hidden sm:inline">{showMoreOptions ? 'Less Options' : 'More Options'}</span>
          </Button>
          <Button
            type="button"
            size="sm"
            className="h-9 rounded-full px-3 sm:px-4"
            onClick={onGenerate}
            disabled={isGenerating || !canGenerate}
          >
            <Sparkles className="h-4 w-4" />
            {isGenerating ? 'Generating...' : 'Generate'}
          </Button>
        </div>
      </div>

      {showMoreOptions && (
        <div className="rounded-xl border border-border/70 bg-background/70 px-2 py-2 shadow-sm sm:rounded-2xl sm:px-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-2 sm:gap-3 lg:grid-cols-4">
            <SelectField label="Provider" value={provider} onChange={onProviderChange}>
              {(mode === 'sound' ? SOUND_PROVIDERS : mode === 'video' ? VIDEO_PROVIDERS : PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id === 'gemini' ? 'Google Gemini' : p.id === 'openai' ? 'OpenAI' : p.id === 'bytedance' ? 'Bytedance' : 'Google Veo'}
                </option>
              ))}
            </SelectField>

            <SelectField label="Model" value={model} onChange={onModelChange}>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {isVideo || isSound
                    ? (MODEL_LABELS[m.id] || m.id)
                    : provider === 'openai'
                      ? m.id === 'gpt-image-2'
                        ? 'GPT Image 2 — Best Quality'
                        : m.id
                      : m.id === GEMINI_FLASH_IMAGE_MODEL_ID
                        ? 'Gemini 3.1 Flash — Best Quality & Features'
                        : m.id === GEMINI_PRO_IMAGE_MODEL_ID
                          ? 'Nano Banana Pro — Pro Quality & Reasoning'
                          : m.id}
                </option>
              ))}
            </SelectField>

            {isOpenAI && mode === 'image' ? (
              <>
                <SelectField label="Quality" value={quality} onChange={(value) => onQualityChange(value as typeof quality)}>
                  {QUALITY_OPTIONS.map((q) => (
                    <option key={q} value={q}>
                      {q.charAt(0).toUpperCase() + q.slice(1)}
                    </option>
                  ))}
                </SelectField>

                <SelectField label="Output Format" value={outputFormat} onChange={(value) => onOutputFormatChange(value as typeof outputFormat)}>
                  {OUTPUT_FORMAT_OPTIONS.map((fmt) => (
                    <option key={fmt} value={fmt}>
                      {fmt.toUpperCase()}
                    </option>
                  ))}
                </SelectField>
              </>
            ) : null}

            {isSound ? (
              <SelectField
                label="Output Format"
                value={model === 'lyria-3-pro-preview' && (outputFormat === 'mp3' || outputFormat === 'wav') ? outputFormat : 'mp3'}
                onChange={(value) => onOutputFormatChange(value as typeof outputFormat)}
                disabled={model !== 'lyria-3-pro-preview'}
              >
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
              </SelectField>
            ) : null}

            {!isOpenAI && mode === 'image' && getImageSizesForModel(model).length > 0 ? (
              <SelectField label="Resolution" value={imageSize} onChange={onImageSizeChange}>
                {getImageSizesForModel(model).map((size) => (
                  <option key={size} value={size}>
                    {imageSizeLabels[size] || size}
                  </option>
                ))}
              </SelectField>
            ) : null}

            {isOpenAI && mode === 'image' ? (
              <SelectField label="Background" value={background} onChange={(value) => onBackgroundChange(value as typeof background)}>
                {BACKGROUND_OPTIONS.map((bg) => (
                  <option key={bg} value={bg}>
                    {bg.charAt(0).toUpperCase() + bg.slice(1)}
                  </option>
                ))}
              </SelectField>
            ) : null}

            {isSeedance ? (
              <>
                <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-xs sm:text-sm">
                  <input
                    type="checkbox"
                    checked={videoGenerateAudio}
                    onChange={(event) => onVideoGenerateAudioChange(event.target.checked)}
                  />
                  <span className="truncate">Generate audio</span>
                </label>
                <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-xs sm:text-sm">
                  <input
                    type="checkbox"
                    checked={videoWebSearch}
                    onChange={(event) => onVideoWebSearchChange(event.target.checked)}
                  />
                  <span className="truncate">Web search</span>
                </label>
                <label className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/60 px-2 py-1.5 text-xs sm:text-sm">
                  <input
                    type="checkbox"
                    checked={videoNsfwChecker}
                    onChange={(event) => onVideoNsfwCheckerChange(event.target.checked)}
                  />
                  <span className="truncate">NSFW checker</span>
                </label>
              </>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
