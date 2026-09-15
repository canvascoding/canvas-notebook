'use client';

import { useState } from 'react';
import { Check, ChevronDown, Scan } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  OPENAI_IMAGE_FORMAT_PRESETS,
  getOpenAIImageAspectRatio,
  getOpenAIImageFormatPreset,
  getOpenAIImageSizeValidationCode,
  normalizeOpenAIImageSizeInput,
  parseOpenAIImageSize,
  type OpenAIImageFormatPreset,
} from '@/app/lib/integrations/image-generation-constants';

interface OpenAIImageFormatPickerProps {
  aspectRatio: string;
  imageSize: string;
  onChange: (format: { aspectRatio: string; imageSize: string }) => void;
}

interface FormatShapeProps {
  width: number | null;
  height: number | null;
  auto?: boolean;
  custom?: boolean;
  className?: string;
}

function FormatShape({ width, height, auto = false, custom = false, className }: FormatShapeProps) {
  const maxWidth = 34;
  const maxHeight = 25;
  const safeWidth = width || 4;
  const safeHeight = height || 3;
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight);
  const rectWidth = safeWidth * scale;
  const rectHeight = safeHeight * scale;
  const x = (44 - rectWidth) / 2;
  const y = (34 - rectHeight) / 2;

  return (
    <svg viewBox="0 0 44 34" aria-hidden="true" className={cn('h-8 w-11', className)}>
      <rect
        x={x}
        y={y}
        width={rectWidth}
        height={rectHeight}
        rx="2.5"
        fill="currentColor"
        fillOpacity="0.06"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={auto ? '3 2.5' : undefined}
      />
      {custom ? (
        <>
          <path d={`M${x - 1} ${y + 7}V${y - 1}H${x + 7}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={`M${x + rectWidth - 7} ${y + rectHeight + 1}H${x + rectWidth + 1}V${y + rectHeight - 7}`} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </>
      ) : null}
      {auto ? <path d="M19 13.5l1 2.25 2.25 1L20 18l-1 2.25L18 18l-2.25-1 2.25-1z" fill="currentColor" /> : null}
    </svg>
  );
}

function presetDescription(preset: OpenAIImageFormatPreset, autoLabel: string) {
  return preset.size === 'auto' ? autoLabel : preset.size.replace('x', ' × ');
}

export function OpenAIImageFormatPicker({
  aspectRatio,
  imageSize,
  onChange,
}: OpenAIImageFormatPickerProps) {
  const t = useTranslations('studio.imageFormat');
  const [open, setOpen] = useState(false);
  const selectedPreset = getOpenAIImageFormatPreset(imageSize);
  const parsedDimensions = parseOpenAIImageSize(imageSize);
  const [customWidth, setCustomWidth] = useState(String(parsedDimensions?.width ?? 1024));
  const [customHeight, setCustomHeight] = useState(String(parsedDimensions?.height ?? 1024));
  const [showCustom, setShowCustom] = useState(!selectedPreset);
  const validationCode = getOpenAIImageSizeValidationCode(imageSize);

  const applyCustomDimension = (width: string, height: string) => {
    const candidate = normalizeOpenAIImageSizeInput(`${width}x${height}`);
    onChange({
      imageSize: candidate,
      aspectRatio: getOpenAIImageAspectRatio(candidate, aspectRatio),
    });
  };

  const triggerRatio = selectedPreset?.aspectRatio ?? getOpenAIImageAspectRatio(imageSize, aspectRatio);
  const triggerSize = normalizeOpenAIImageSizeInput(imageSize);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const dimensions = parseOpenAIImageSize(imageSize);
          if (dimensions) {
            setCustomWidth(String(dimensions.width));
            setCustomHeight(String(dimensions.height));
          }
          setShowCustom(!getOpenAIImageFormatPreset(imageSize));
        }
        setOpen(nextOpen);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(
            'h-9 rounded-full px-2.5',
            validationCode && 'border-destructive text-destructive',
          )}
          aria-label={t('triggerLabel', { ratio: triggerRatio, size: triggerSize })}
        >
          <FormatShape
            width={selectedPreset?.width ?? parsedDimensions?.width ?? null}
            height={selectedPreset?.height ?? parsedDimensions?.height ?? null}
            auto={triggerSize === 'auto'}
            className="h-5 w-7"
          />
          <span>{triggerRatio === 'auto' ? t('auto') : triggerRatio}</span>
          <span className="hidden text-muted-foreground md:inline">{triggerSize === 'auto' ? '' : `· ${triggerSize.replace('x', '×')}`}</span>
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,430px)] rounded-2xl p-3">
        <div className="mb-3 flex items-start justify-between gap-3 px-1">
          <div>
            <p className="text-sm font-semibold">{t('title')}</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t('description')}</p>
          </div>
          <Scan className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        </div>

        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
          {OPENAI_IMAGE_FORMAT_PRESETS.map((preset) => {
            const selected = selectedPreset?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                className={cn(
                  'group relative flex min-h-[86px] flex-col items-center justify-center rounded-xl border px-1.5 py-2 text-center transition-colors',
                  'hover:border-foreground/25 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-foreground/30 bg-accent text-foreground' : 'border-border/70 bg-background',
                )}
                onClick={() => {
                  setShowCustom(false);
                  onChange({ aspectRatio: preset.aspectRatio, imageSize: preset.size });
                  setOpen(false);
                }}
                aria-pressed={selected}
              >
                {selected ? <Check className="absolute right-1.5 top-1.5 h-3.5 w-3.5" /> : null}
                <FormatShape width={preset.width} height={preset.height} auto={preset.size === 'auto'} />
                <span className="mt-1 text-xs font-medium">{preset.aspectRatio === 'auto' ? t('auto') : preset.aspectRatio}</span>
                <span className="text-[9px] text-muted-foreground">{presetDescription(preset, t('automatic'))}</span>
              </button>
            );
          })}

          <button
            type="button"
            className={cn(
              'relative flex min-h-[86px] flex-col items-center justify-center rounded-xl border px-1.5 py-2 text-center transition-colors',
              'hover:border-foreground/25 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              showCustom && !selectedPreset ? 'border-foreground/30 bg-accent text-foreground' : 'border-border/70 bg-background',
            )}
            onClick={() => {
              setShowCustom(true);
              if (!parsedDimensions) {
                setCustomWidth('1024');
                setCustomHeight('1024');
                onChange({ aspectRatio: '1:1', imageSize: '1024x1024' });
              }
            }}
            aria-pressed={showCustom && !selectedPreset}
          >
            <FormatShape width={4} height={3} custom />
            <span className="mt-1 text-xs font-medium">{t('custom')}</span>
            <span className="text-[9px] text-muted-foreground">W × H</span>
          </button>
        </div>

        {showCustom ? (
          <div className="mt-3 rounded-xl border border-border/70 bg-muted/30 p-3">
            <div className="flex items-end gap-2">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('width')}</span>
                <input
                  type="number"
                  min={16}
                  max={3840}
                  step={16}
                  inputMode="numeric"
                  value={customWidth}
                  onChange={(event) => {
                    const width = event.target.value;
                    setCustomWidth(width);
                    applyCustomDimension(width, customHeight);
                  }}
                  className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm tabular-nums"
                />
              </label>
              <span className="pb-2 text-sm text-muted-foreground">×</span>
              <label className="min-w-0 flex-1">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('height')}</span>
                <input
                  type="number"
                  min={16}
                  max={3840}
                  step={16}
                  inputMode="numeric"
                  value={customHeight}
                  onChange={(event) => {
                    const height = event.target.value;
                    setCustomHeight(height);
                    applyCustomDimension(customWidth, height);
                  }}
                  className="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm tabular-nums"
                />
              </label>
              <div className="flex h-9 min-w-14 items-center justify-center rounded-lg bg-background px-2 text-xs font-medium tabular-nums">
                {getOpenAIImageAspectRatio(imageSize, aspectRatio)}
              </div>
            </div>
            <p className={cn('mt-2 text-[10px] leading-relaxed', validationCode ? 'text-destructive' : 'text-muted-foreground')}>
              {validationCode ? t(`errors.${validationCode}`) : t('requirements')}
            </p>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
