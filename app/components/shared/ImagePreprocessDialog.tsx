'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Image, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';

export interface PreprocessFileInfo {
  file: File;
  isHeic: boolean;
  isLarge: boolean;
}

export interface ConvertParams {
  format: 'jpg' | 'webp' | 'png';
  quality: number;
  maxDimension?: number;
}

export interface ImagePreprocessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PreprocessFileInfo[];
  onConfirm: (convertParams: (ConvertParams | null)[]) => void;
  onSkip?: () => void;
}

const SIZE_THRESHOLD = 1_500_000;

const QUALITY_PRESETS = [
  { label: 'Low', value: 60 },
  { label: 'Mid', value: 80 },
  { label: 'High', value: 95 },
] as const;

const DIMENSION_OPTIONS = [
  { label: 'Original', value: undefined },
  { label: '2048px', value: 2048 },
  { label: '4096px', value: 4096 },
] as const;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFormatForFile(file: File, isHeic: boolean): 'jpg' | 'webp' | 'png' {
  if (isHeic) return 'jpg';
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'png';
  if (ext === 'webp') return 'webp';
  return 'jpg';
}

export function ImagePreprocessDialog({
  open,
  onOpenChange,
  files,
  onConfirm,
  onSkip,
}: ImagePreprocessDialogProps) {
  const t = useTranslations('notebook');

  const [applyToAll, setApplyToAll] = useState(false);
  const [globalFormat, setGlobalFormat] = useState<'jpg' | 'webp' | 'png'>('jpg');
  const [globalQuality, setGlobalQuality] = useState<number>(80);
  const [globalDimension, setGlobalDimension] = useState<number | undefined>(undefined);
  const [customQuality, setCustomQuality] = useState(false);
  const [customQualityValue, setCustomQualityValue] = useState(80);
  const [perFileFormat, setPerFileFormat] = useState<Record<number, 'jpg' | 'webp' | 'png'>>({});
  const [perFileQuality, setPerFileQuality] = useState<Record<number, number>>({});
  const [perFileDimension, setPerFileDimension] = useState<Record<number, number | undefined>>({});

  const hasHeic = files.some((f) => f.isHeic);
  const allHeic = files.every((f) => f.isHeic);
  const canSkip = !hasHeic;

  const effectiveQuality = customQuality ? customQualityValue : globalQuality;

  const handleConfirm = useCallback(() => {
    const params: (ConvertParams | null)[] = files.map((f, i) => {
      const format = applyToAll ? globalFormat : (perFileFormat[i] ?? getFormatForFile(f.file, f.isHeic));
      const quality = applyToAll ? effectiveQuality : (perFileQuality[i] ?? 80);
      const maxDimension = applyToAll ? globalDimension : perFileDimension[i];
      return {
        format,
        quality,
        maxDimension,
      };
    });
    onConfirm(params);
  }, [files, applyToAll, globalFormat, effectiveQuality, globalDimension, perFileFormat, perFileQuality, perFileDimension, onConfirm]);

  const showPerFileControls = !applyToAll && files.length > 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('imagePreprocessTitle')}</DialogTitle>
          <DialogDescription>{t('imagePreprocessDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {files.map((f, i) => {
            const isHeic = f.isHeic;
            const isLarge = f.isLarge;
            const fileFormat = applyToAll ? globalFormat : (perFileFormat[i] ?? getFormatForFile(f.file, isHeic));
            const fileQuality = applyToAll ? effectiveQuality : (perFileQuality[i] ?? 80);
            const fileDimension = applyToAll ? globalDimension : (perFileDimension[i] ?? undefined);

            return (
              <div key={i} className="rounded-lg border border-border p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Image className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium truncate">{f.file.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">({formatSize(f.file.size)})</span>
                  <div className="flex gap-1 ml-auto shrink-0">
                    {isHeic && (
                      <span className="inline-flex items-center rounded-full bg-orange-100 text-orange-800 px-2 py-0.5 text-xs font-medium">
                        HEIC
                      </span>
                    )}
                    {isLarge && !isHeic && (
                      <span className="inline-flex items-center rounded-full bg-yellow-100 text-yellow-800 px-2 py-0.5 text-xs font-medium">
                        {t('imagePreprocessLarge')}
                      </span>
                    )}
                  </div>
                </div>

                {(showPerFileControls || files.length === 1) && (
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessFormat')}</label>
                      <select
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                        value={fileFormat}
                        disabled={isHeic || applyToAll}
                        onChange={(e) => {
                          if (!applyToAll) {
                            setPerFileFormat((prev) => ({ ...prev, [i]: e.target.value as 'jpg' | 'webp' | 'png' }));
                          }
                        }}
                      >
                        {isHeic ? (
                          <option value="jpg">JPG</option>
                        ) : (
                          <>
                            <option value="jpg">JPG</option>
                            <option value="webp">WebP</option>
                            <option value="png">PNG</option>
                          </>
                        )}
                      </select>
                    </div>
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                      <div className="flex gap-1">
                        {QUALITY_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={`px-1.5 py-1 rounded text-xs border ${
                              (applyToAll ? effectiveQuality : fileQuality) === preset.value
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-background border-input hover:bg-accent'
                            }`}
                            disabled={applyToAll}
                            onClick={() => {
                              if (!applyToAll) {
                                setCustomQuality(false);
                                setPerFileQuality((prev) => ({ ...prev, [i]: preset.value }));
                              }
                            }}
                          >
                            {preset.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className={`px-1.5 py-1 rounded text-xs border ${
                            customQuality ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-accent'
                          }`}
                          disabled={applyToAll}
                          onClick={() => {
                            if (!applyToAll) {
                              setCustomQuality(!customQuality);
                            }
                          }}
                        >
                          Custom
                        </button>
                      </div>
                      {customQuality && !applyToAll && (
                        <input
                          type="range"
                          min={1}
                          max={100}
                          value={customQualityValue}
                          onChange={(e) => setCustomQualityValue(Number(e.target.value))}
                          className="w-full mt-1"
                        />
                      )}
                    </div>
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                      <select
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                        value={fileDimension ?? 'original'}
                        disabled={applyToAll}
                        onChange={(e) => {
                          if (!applyToAll) {
                            const val = e.target.value === 'original' ? undefined : Number(e.target.value);
                            setPerFileDimension((prev) => ({ ...prev, [i]: val }));
                          }
                        }}
                      >
                        {DIMENSION_OPTIONS.map((opt) => (
                          <option key={opt.label} value={opt.value ?? 'original'}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {files.length > 1 && (
            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                  className="rounded border-input"
                />
                {t('imagePreprocessApplyToAll')}
              </label>
            </div>
          )}

          {applyToAll && (
            <div className="grid grid-cols-3 gap-2 text-xs border border-border rounded-lg p-3">
              <div>
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessFormat')}</label>
                <select
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={globalFormat}
                  onChange={(e) => setGlobalFormat(e.target.value as 'jpg' | 'webp' | 'png')}
                >
                  {allHeic ? (
                    <option value="jpg">JPG</option>
                  ) : (
                    <>
                      <option value="jpg">JPG</option>
                      <option value="webp">WebP</option>
                      <option value="png">PNG</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                <div className="flex gap-1">
                  {QUALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={`px-1.5 py-1 rounded text-xs border ${
                        effectiveQuality === preset.value && !customQuality
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-input hover:bg-accent'
                      }`}
                      onClick={() => {
                        setCustomQuality(false);
                        setGlobalQuality(preset.value);
                      }}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`px-1.5 py-1 rounded text-xs border ${
                      customQuality
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input hover:bg-accent'
                    }`}
                    onClick={() => setCustomQuality(!customQuality)}
                  >
                    Custom
                  </button>
                </div>
                {customQuality && (
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={customQualityValue}
                    onChange={(e) => setCustomQualityValue(Number(e.target.value))}
                    className="w-full mt-1"
                  />
                )}
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                <select
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={globalDimension ?? 'original'}
                  onChange={(e) => {
                    const val = e.target.value === 'original' ? undefined : Number(e.target.value);
                    setGlobalDimension(val);
                  }}
                >
                  {DIMENSION_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.value ?? 'original'}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {hasHeic && (
            <div className="flex items-start gap-2 rounded-lg bg-orange-50 dark:bg-orange-950/20 p-3 text-xs text-orange-800 dark:text-orange-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{t('imagePreprocessHeicWarning')}</span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {canSkip && onSkip && (
            <Button variant="ghost" onClick={onSkip}>
              {t('imagePreprocessSkip')}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={handleConfirm}>
            {t('imagePreprocessConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}