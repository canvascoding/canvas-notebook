'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { StudioBulkJob } from '../../types/bulk';

interface BulkProgressTrackerProps {
  job: StudioBulkJob;
  onCancel: () => void;
}

export function BulkProgressTracker({ job, onCancel }: BulkProgressTrackerProps) {
  const t = useTranslations('studio.bulk');
  const processed = job.completedLineItems + job.failedLineItems;
  const progress = job.totalLineItems > 0 ? processed / job.totalLineItems : 0;
  const isActive = job.status === 'pending' || job.status === 'processing';

  const statusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <span className="text-muted-foreground">\u23F3</span>;
      case 'processing': return <span className="animate-pulse text-blue-500">\uD83D\uDD04</span>;
      case 'completed': return <span className="text-green-600">\u2705</span>;
      case 'failed': return <span className="text-red-500">\u274C</span>;
      default: return null;
    }
  };

  const jobStatusBadge = () => {
    switch (job.status) {
      case 'pending':
        return <Badge variant="outline" className="rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">{t('statusPending')}</Badge>;
      case 'processing':
        return <Badge variant="outline" className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">{t('statusProcessing')}</Badge>;
      case 'completed':
        return <Badge variant="outline" className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-200">{t('statusCompleted')}</Badge>;
      case 'partial':
        return <Badge variant="outline" className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">{t('statusPartial')}</Badge>;
      case 'failed':
        return <Badge variant="outline" className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-200">{t('statusFailed')}</Badge>;
    }
  };

  let lastProductName = '';
  let versionIndex = 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{t('progressTitle')}</h3>
          {jobStatusBadge()}
        </div>
        {isActive && (
          <Button variant="destructive" size="sm" onClick={onCancel}>
            {t('cancelButton')}
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('progressCompleted', { completed: processed, total: job.totalLineItems })}{job.failedLineItems > 0 ? ` (${job.failedLineItems} failed)` : ''}</span>
          <span>{t('progressPercent', { percent: Math.round(progress * 100) })}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto rounded-xl border border-border/60">
        {job.lineItems.map((item, i) => {
          const isNewProduct = item.productName !== lastProductName;
          if (isNewProduct) {
            // eslint-disable-next-line react-hooks/immutability
            versionIndex = 0;
            lastProductName = item.productName ?? 'Unknown';
          }
          versionIndex++;

          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-sm last:border-b-0 ${isNewProduct && i > 0 ? 'mt-1 border-t border-border' : ''}`}
            >
              {statusIcon(item.status)}
              <span className="truncate">
                {item.productName ?? 'Unknown'}
                {job.versionsPerProduct > 1 && ` v${versionIndex}`}
              </span>
              {item.status === 'completed' && item.outputs && item.outputs.length > 0 && item.outputs[0].mediaUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.outputs[0].mediaUrl}
                  alt=""
                  className="ml-auto h-8 w-8 rounded object-cover"
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
