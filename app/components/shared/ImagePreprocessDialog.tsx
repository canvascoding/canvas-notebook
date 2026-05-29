'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Image as ImageIcon, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  getDefaultImageConvertFormat,
  getDefaultImageMaxDimension,
} from '@/app/lib/images/client-preprocess';

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
  isProcessing?: boolean;
}

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

type DimensionValue = number | 'original';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getQualityForFile(
  index: number,
  perFileQuality: Record<number, number>,
): number {
  if (perFileQuality[index] !== undefined) {
    return perFileQuality[index];
  }

  return 80;
}

function resolveDimensionValue(value: DimensionValue | null | undefined, defaultValue?: number): number | undefined {
  if (value === 'original') return undefined;
  return value ?? defaultValue;
}

export function ImagePreprocessDialog({
  open,
  onOpenChange,
  files,
  onConfirm,
  onSkip,
  isProcessing = false,
}: ImagePreprocessDialogProps) {
  const t = useTranslations('notebook');

  const [applyToAll, setApplyToAll] = useState(false);
  const [globalFormat, setGlobalFormat] = useState<'jpg' | 'webp' | 'png' | null>(null);
  const [globalQuality, setGlobalQuality] = useState<number>(80);
  const [globalDimension, setGlobalDimension] = useState<DimensionValue | null>(null);
  const [globalCustomQuality, setGlobalCustomQuality] = useState(false);
  const [globalCustomQualityValue, setGlobalCustomQualityValue] = useState(80);
  const [perFileFormat, setPerFileFormat] = useState<Record<number, 'jpg' | 'webp' | 'png'>>({});
  const [perFileQuality, setPerFileQuality] = useState<Record<number, number>>({});
  const [perFileCustomQuality, setPerFileCustomQuality] = useState<Record<number, boolean>>({});
  const [perFileDimension, setPerFileDimension] = useState<Record<number, DimensionValue>>({});

  const hasHeic = files.some((f) => f.isHeic);
  const _allHeic = files.every((f) => f.isHeic);
  const canSkip = !hasHeic;
  const defaultGlobalFormat = useMemo(() => {
    if (files.length === 0) return 'jpg';
    const defaultFormats = files.map((f) => getDefaultImageConvertFormat(f.file, f.isHeic));
    return defaultFormats.every((format) => format === defaultFormats[0]) ? defaultFormats[0] : 'jpg';
  }, [files]);
  const defaultGlobalDimension = useMemo(() => (
    files.some((f) => f.isLarge) ? getDefaultImageMaxDimension(true) : undefined
  ), [files]);

  const effectiveGlobalQuality = globalCustomQuality ? globalCustomQualityValue : globalQuality;
  const effectiveGlobalFormat = globalFormat ?? defaultGlobalFormat;
  const effectiveGlobalDimension = resolveDimensionValue(globalDimension, defaultGlobalDimension);

  const resetState = useCallback(() => {
    setApplyToAll(false);
    setGlobalFormat(null);
    setGlobalQuality(80);
    setGlobalDimension(null);
    setGlobalCustomQuality(false);
    setGlobalCustomQualityValue(80);
    setPerFileFormat({});
    setPerFileQuality({});
    setPerFileCustomQuality({});
    setPerFileDimension({});
  }, []);

  const handleConfirm = useCallback(() => {
      const params: (ConvertParams | null)[] = files.map((f, i) => {
        const format = applyToAll
          ? effectiveGlobalFormat
          : (perFileFormat[i] ?? getDefaultImageConvertFormat(f.file, f.isHeic));
        const quality = applyToAll ? effectiveGlobalQuality : getQualityForFile(i, perFileQuality);
        const maxDimension = applyToAll
          ? effectiveGlobalDimension
          : resolveDimensionValue(perFileDimension[i], getDefaultImageMaxDimension(f.isLarge));
      return {
        format,
        quality,
        maxDimension,
      };
    });
    resetState();
    onConfirm(params);
  }, [files, applyToAll, effectiveGlobalFormat, effectiveGlobalQuality, effectiveGlobalDimension, perFileFormat, perFileQuality, perFileDimension, onConfirm, resetState]);

  const showPerFileControls = !applyToAll && files.length > 1;
  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      resetState();
    }
    onOpenChange(nextOpen);
  }, [onOpenChange, resetState]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto px-4 sm:px-6">
        <DialogHeader>
          <DialogTitle>{t('imagePreprocessTitle')}</DialogTitle>
          <DialogDescription>{t('imagePreprocessDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {files.map((f, i) => {
             const isHeic = f.isHeic;
             const isLarge = f.isLarge;
               const fileFormat = applyToAll
	               ? effectiveGlobalFormat
	               : (perFileFormat[i] ?? getDefaultImageConvertFormat(f.file, isHeic));
            const fileQuality = applyToAll ? effectiveGlobalQuality : getQualityForFile(i, perFileQuality);
            const fileDimension = applyToAll
              ? effectiveGlobalDimension
              : resolveDimensionValue(perFileDimension[i], getDefaultImageMaxDimension(isLarge));
            const isCustomQuality = !!perFileCustomQuality[i];

            return (
              <div key={i} className="rounded-lg border border-border p-3 sm:p-4 space-y-3">
                <div className="flex flex-wrap items-start gap-2">
                  <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 break-all text-sm font-medium">{f.file.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">({formatSize(f.file.size)})</span>
                  <div className="flex flex-wrap gap-1 sm:ml-auto shrink-0">
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
                  <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessFormat')}</label>
                      <select
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                          value={fileFormat}
                          disabled={applyToAll || isProcessing}
                          onChange={(e) => {
                            if (!applyToAll) {
                              setPerFileFormat((prev) => ({ ...prev, [i]: e.target.value as 'jpg' | 'webp' | 'png' }));
                            }
                          }}
                        >
                          <option value="jpg">JPG</option>
                          <option value="webp">WebP</option>
                          <option value="png">PNG</option>
                        </select>
                    </div>
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                      <div className="flex flex-wrap gap-1.5">
                        {QUALITY_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={`min-w-[3.5rem] px-2 py-1.5 rounded text-xs border ${
                              (applyToAll ? effectiveGlobalQuality : fileQuality) === preset.value
                                ? 'bg-primary text-primary-foreground border-primary'
                                : 'bg-background border-input hover:bg-accent'
                            }`}
	                          disabled={applyToAll || isProcessing}
                            onClick={() => {
                              if (!applyToAll) {
                                setPerFileCustomQuality((prev) => ({ ...prev, [i]: false }));
                                setPerFileQuality((prev) => ({ ...prev, [i]: preset.value }));
                              }
                            }}
                          >
                            {preset.label}
                          </button>
                        ))}
                        <button
                          type="button"
                          className={`min-w-[4.5rem] px-2 py-1.5 rounded text-xs border ${
                            isCustomQuality ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-input hover:bg-accent'
                          }`}
	                          disabled={applyToAll || isProcessing}
                          onClick={() => {
                            if (!applyToAll) {
                              setPerFileCustomQuality((prev) => {
                                const nextValue = !prev[i];
                                if (nextValue) {
                                  setPerFileQuality((current) => ({
                                    ...current,
                                    [i]: current[i] ?? 80,
                                  }));
                                }
                                return { ...prev, [i]: nextValue };
                              });
                            }
                          }}
                        >
                          Custom
                        </button>
                      </div>
                      {isCustomQuality && !applyToAll && (
                        <input
                          type="range"
                          min={1}
                          max={100}
                          value={fileQuality}
                          onChange={(e) =>
                            setPerFileQuality((prev) => ({
                              ...prev,
                              [i]: Number(e.target.value),
                            }))
                          }
                          className="w-full mt-1"
                        />
                      )}
                    </div>
                    <div>
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                      <select
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                        value={fileDimension ?? 'original'}
	                        disabled={applyToAll || isProcessing}
                        onChange={(e) => {
                          if (!applyToAll) {
	                            const val: DimensionValue = e.target.value === 'original' ? 'original' : Number(e.target.value);
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
            <div className="flex items-center gap-2 pt-3 border-t border-border">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                  disabled={isProcessing}
                  className="rounded border-input"
                />
                {t('imagePreprocessApplyToAll')}
              </label>
            </div>
          )}

          {applyToAll && (
            <div className="grid grid-cols-1 gap-3 text-xs border border-border rounded-lg p-3 sm:grid-cols-3 sm:p-4">
              <div>
                <label className="text-muted-foreground block mb-1">
                  {t('imagePreprocessFormat')}
                </label>
                <select
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                  value={effectiveGlobalFormat}
                  disabled={isProcessing}
                  onChange={(e) => setGlobalFormat(e.target.value as 'jpg' | 'webp' | 'png')}
                >
                  <option value="jpg">JPG</option>
                  <option value="webp">WebP</option>
                  <option value="png">PNG</option>
                </select>
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                <div className="flex flex-wrap gap-1.5">
                  {QUALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={`min-w-[3.5rem] px-2 py-1.5 rounded text-xs border ${
                        effectiveGlobalQuality === preset.value && !globalCustomQuality
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-input hover:bg-accent'
                      }`}
	                      onClick={() => {
	                        setGlobalCustomQuality(false);
	                        setGlobalQuality(preset.value);
	                      }}
	                      disabled={isProcessing}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`min-w-[4.5rem] px-2 py-1.5 rounded text-xs border ${
                      globalCustomQuality
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input hover:bg-accent'
                    }`}
	                    onClick={() => setGlobalCustomQuality(!globalCustomQuality)}
	                    disabled={isProcessing}
                  >
                    Custom
                  </button>
                </div>
                {globalCustomQuality && (
                  <input
                    type="range"
                    min={1}
                    max={100}
                    value={globalCustomQualityValue}
                    onChange={(e) => setGlobalCustomQualityValue(Number(e.target.value))}
                    className="w-full mt-1"
                  />
                )}
              </div>
              <div>
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                <select
                  className="w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
		                  value={effectiveGlobalDimension ?? 'original'}
	                  disabled={isProcessing}
                  onChange={(e) => {
	                    const val: DimensionValue = e.target.value === 'original' ? 'original' : Number(e.target.value);
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

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {canSkip && onSkip && (
            <Button className="w-full sm:w-auto" variant="ghost" disabled={isProcessing} onClick={() => {
	              resetState();
	              onSkip();
	            }}>
              {t('imagePreprocessSkip')}
            </Button>
          )}
	          <Button className="w-full sm:w-auto" variant="outline" disabled={isProcessing} onClick={() => handleDialogOpenChange(false)}>
	            {t('cancel')}
	          </Button>
	          <Button className="w-full sm:w-auto" disabled={isProcessing} onClick={handleConfirm}>
	            {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
	            {t('imagePreprocessConfirm')}
	          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
