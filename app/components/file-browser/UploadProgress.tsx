'use client';

import { useTranslations } from 'next-intl';

interface UploadProgressProps {
  value: number;
  className?: string;
}

export function UploadProgress({ value, className }: UploadProgressProps) {
  const t = useTranslations('notebook');
  const progress = Math.min(100, Math.max(0, Math.round(value)));

  return (
    <div
      className={className}
      role="progressbar"
      aria-label={t('uploadProgress')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
    >
      <div className="mb-1 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span>{t('uploading')}</span>
        <span className="tabular-nums">{progress}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
