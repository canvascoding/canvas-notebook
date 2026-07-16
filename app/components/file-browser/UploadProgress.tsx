'use client';

import { useTranslations } from 'next-intl';
import type { WorkspaceUploadFileProgress } from '@/app/lib/files/client';

interface UploadProgressProps {
  value: number;
  className?: string;
  items?: WorkspaceUploadFileProgress[];
}

export function UploadProgress({ value, className, items = [] }: UploadProgressProps) {
  const t = useTranslations('notebook');
  const progress = Math.min(100, Math.max(0, Math.round(value)));
  const completedCount = items.filter((item) => item.status === 'completed').length;
  const failedCount = items.filter((item) => item.status === 'failed').length;
  const activeItem = items.find((item) => item.status === 'uploading' || item.status === 'retrying')
    ?? items.find((item) => item.status === 'pending');

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
        <span>
          {items.length > 0
            ? t('uploadBatchProgress', { completed: completedCount, total: items.length })
            : t('uploading')}
        </span>
        <span className="tabular-nums">{progress}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
      {activeItem && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={activeItem.path}>
          {activeItem.status === 'retrying'
            ? t('uploadRetryingFile', { name: activeItem.path, attempt: activeItem.attempt })
            : t('uploadCurrentFile', { name: activeItem.path })}
        </p>
      )}
      {failedCount > 0 && (
        <p className="mt-1 text-[11px] text-destructive">
          {t('uploadFailedCount', { count: failedCount })}
        </p>
      )}
    </div>
  );
}
