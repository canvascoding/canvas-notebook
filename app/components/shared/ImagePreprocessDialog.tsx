'use client';

import { useMemo, useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, Clock3, Image as ImageIcon, Loader2, XCircle } from 'lucide-react';
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

export type ImagePreprocessProgressStatus =
  | 'queued'
  | 'processing'
  | 'uploading'
  | 'success'
  | 'error'
  | 'skipped';

export interface ImagePreprocessProgressItem {
  fileName: string;
  size: number;
  status: ImagePreprocessProgressStatus;
  detail?: string;
}

export interface ImagePreprocessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: PreprocessFileInfo[];
  onConfirm: (convertParams: (ConvertParams | null)[]) => void | Promise<void>;
  onSkip?: () => void;
  isProcessing?: boolean;
  progressItems?: ImagePreprocessProgressItem[];
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

const SELECT_CLASS = 'h-10 w-full rounded-md border border-input bg-background px-3 text-sm';
const CONTROL_GRID_CLASS = 'grid grid-cols-1 gap-3 text-xs md:grid-cols-[minmax(9rem,1fr)_minmax(12rem,1.2fr)_minmax(9rem,1fr)]';

function qualityButtonClass(active: boolean): string {
  return `h-9 min-w-0 rounded-md border px-2 text-xs transition ${
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-input bg-background hover:bg-accent'
  }`;
}

type DimensionValue = number | 'original';

const FINAL_PROGRESS_STATUSES = new Set<ImagePreprocessProgressStatus>(['success', 'error', 'skipped']);

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

function getProgressPercent(items: ImagePreprocessProgressItem[]): number {
  if (items.length === 0) return 0;
  const completed = items.filter((item) => FINAL_PROGRESS_STATUSES.has(item.status)).length;
  return Math.round((completed / items.length) * 100);
}

function getStatusClasses(status: ImagePreprocessProgressStatus): string {
  switch (status) {
    case 'success':
      return 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-200';
    case 'error':
      return 'border-destructive/30 bg-destructive/10 text-destructive';
    case 'processing':
    case 'uploading':
      return 'border-primary/30 bg-primary/10 text-primary';
    case 'skipped':
      return 'border-muted bg-muted text-muted-foreground';
    case 'queued':
    default:
      return 'border-border bg-background text-muted-foreground';
  }
}

function ProgressStatusIcon({ status }: { status: ImagePreprocessProgressStatus }) {
  if (status === 'success') return <CheckCircle2 className="h-4 w-4" />;
  if (status === 'error') return <XCircle className="h-4 w-4" />;
  if (status === 'processing' || status === 'uploading') return <Loader2 className="h-4 w-4 animate-spin" />;
  return <Clock3 className="h-4 w-4" />;
}

function getProgressStatusLabel(
  status: ImagePreprocessProgressStatus,
  t: ReturnType<typeof useTranslations>,
): string {
  switch (status) {
    case 'processing':
      return t('imagePreprocessStatus.processing');
    case 'uploading':
      return t('imagePreprocessStatus.uploading');
    case 'success':
      return t('imagePreprocessStatus.success');
    case 'error':
      return t('imagePreprocessStatus.error');
    case 'skipped':
      return t('imagePreprocessStatus.skipped');
    case 'queued':
    default:
      return t('imagePreprocessStatus.queued');
  }
}

export function ImagePreprocessDialog({
  open,
  onOpenChange,
  files,
  onConfirm,
  onSkip,
  isProcessing = false,
  progressItems = [],
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
  const hasProgress = progressItems.length > 0;
  const completedProgressCount = progressItems.filter((item) => FINAL_PROGRESS_STATUSES.has(item.status)).length;
  const progressPercent = getProgressPercent(progressItems);
  const activeProgressItem = progressItems.find((item) => item.status === 'processing' || item.status === 'uploading');
  const hasProgressErrors = progressItems.some((item) => item.status === 'error');

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
    onConfirm(params);
  }, [files, applyToAll, effectiveGlobalFormat, effectiveGlobalQuality, effectiveGlobalDimension, perFileFormat, perFileQuality, perFileDimension, onConfirm]);

  const showPerFileControls = !applyToAll && files.length > 1;
  const handleDialogOpenChange = useCallback((nextOpen: boolean) => {
    if (!nextOpen && isProcessing) {
      return;
    }
    if (!nextOpen) {
      resetState();
    }
    onOpenChange(nextOpen);
  }, [isProcessing, onOpenChange, resetState]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        className="!flex !max-h-[92dvh] !w-[calc(100vw-1rem)] !max-w-none !flex-col !gap-0 !overflow-hidden !p-0 sm:!w-[min(760px,calc(100vw-3rem))]"
        showCloseButton={!isProcessing}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-6 sm:py-5">
          <DialogTitle className="text-xl leading-tight">{t('imagePreprocessTitle')}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed sm:text-base">{t('imagePreprocessDescription')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
          {hasProgress ? (
            <>
              <div className="rounded-md border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {isProcessing
                        ? t('imagePreprocessProcessingTitle')
                        : hasProgressErrors
                          ? t('imagePreprocessProcessingFinishedWithErrors')
                          : t('imagePreprocessProcessingFinished')}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {activeProgressItem
                        ? t('imagePreprocessProcessingCurrent', { file: activeProgressItem.fileName })
                        : t('imagePreprocessProcessingComplete', {
                            completed: completedProgressCount,
                            total: progressItems.length,
                          })}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium text-muted-foreground">
                    {completedProgressCount}/{progressItems.length}
                  </span>
                </div>
                <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
              </div>

              <div className="space-y-2">
                {progressItems.map((item, index) => (
                  <div key={`${item.fileName}-${index}`} className={`rounded-md border p-3 ${getStatusClasses(item.status)}`}>
                    <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2">
                      <ProgressStatusIcon status={item.status} />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium leading-snug">{item.fileName}</p>
                        <p className="mt-1 text-xs opacity-80">{formatSize(item.size)}</p>
                        {item.detail ? (
                          <p className="mt-2 break-words text-xs opacity-90">{item.detail}</p>
                        ) : null}
                      </div>
                      <span className="shrink-0 rounded-full border border-current/20 px-2 py-0.5 text-xs font-medium">
                        {getProgressStatusLabel(item.status, t)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : files.map((f, i) => {
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
              <div key={i} className="space-y-3 rounded-md border border-border bg-card p-3 sm:p-4">
                <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1 sm:grid-cols-[1rem_minmax(0,1fr)_auto]">
                  <ImageIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium leading-snug">{f.file.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">{formatSize(f.file.size)}</p>
                  </div>
                  <div className="col-start-2 flex flex-wrap gap-1 sm:col-start-auto sm:justify-end">
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
                  <div className={CONTROL_GRID_CLASS}>
                    <div className="min-w-0">
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessFormat')}</label>
                      <select
                          className={SELECT_CLASS}
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
                    <div className="min-w-0">
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                        {QUALITY_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={qualityButtonClass((applyToAll ? effectiveGlobalQuality : fileQuality) === preset.value)}
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
                          className={qualityButtonClass(isCustomQuality)}
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
                    <div className="min-w-0">
                      <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                      <select
                        className={SELECT_CLASS}
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

          {!hasProgress && files.length > 1 && (
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

          {!hasProgress && applyToAll && (
            <div className={`${CONTROL_GRID_CLASS} rounded-md border border-border bg-card p-3 sm:p-4`}>
              <div className="min-w-0">
                <label className="text-muted-foreground block mb-1">
                  {t('imagePreprocessFormat')}
                </label>
                <select
                  className={SELECT_CLASS}
                  value={effectiveGlobalFormat}
                  disabled={isProcessing}
                  onChange={(e) => setGlobalFormat(e.target.value as 'jpg' | 'webp' | 'png')}
                >
                  <option value="jpg">JPG</option>
                  <option value="webp">WebP</option>
                  <option value="png">PNG</option>
                </select>
              </div>
              <div className="min-w-0">
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessQuality')}</label>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                  {QUALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.value}
                      type="button"
                      className={qualityButtonClass(effectiveGlobalQuality === preset.value && !globalCustomQuality)}
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
                    className={qualityButtonClass(globalCustomQuality)}
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
              <div className="min-w-0">
                <label className="text-muted-foreground block mb-1">{t('imagePreprocessMaxDimension')}</label>
                <select
                  className={SELECT_CLASS}
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

          {!hasProgress && hasHeic && (
            <div className="flex items-start gap-2 rounded-lg bg-orange-50 dark:bg-orange-950/20 p-3 text-xs text-orange-800 dark:text-orange-200">
              <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>{t('imagePreprocessHeicWarning')}</span>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border px-4 py-3 sm:flex-row sm:justify-end sm:px-6">
          {hasProgress && !isProcessing ? (
            <Button className="w-full sm:w-auto" variant={hasProgressErrors ? 'outline' : 'default'} onClick={() => handleDialogOpenChange(false)}>
              {t('close')}
            </Button>
          ) : null}
          {!hasProgress && canSkip && onSkip && (
            <Button className="w-full min-w-0 !whitespace-normal sm:w-auto sm:!whitespace-nowrap" variant="ghost" disabled={isProcessing} onClick={() => {
	              resetState();
	              onSkip();
	            }}>
              {t('imagePreprocessSkip')}
            </Button>
          )}
	          {!hasProgress ? <Button className="w-full min-w-0 !whitespace-normal sm:w-auto sm:!whitespace-nowrap" variant="outline" disabled={isProcessing} onClick={() => handleDialogOpenChange(false)}>
	            {t('cancel')}
	          </Button> : null}
	          {!hasProgress ? <Button className="w-full min-w-0 !whitespace-normal sm:w-auto sm:!whitespace-nowrap" disabled={isProcessing} onClick={handleConfirm}>
	            {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
	            {t('imagePreprocessConfirm')}
	          </Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
