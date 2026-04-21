'use client';

import { Button } from '@/components/ui/button';
import type { StudioBulkJob } from '../../types/bulk';

interface BulkProgressTrackerProps {
  job: StudioBulkJob;
  onCancel: () => void;
}

export function BulkProgressTracker({ job, onCancel }: BulkProgressTrackerProps) {
  const processed = job.completedLineItems + job.failedLineItems;
  const progress = job.totalLineItems > 0 ? processed / job.totalLineItems : 0;
  const isActive = job.status === 'pending' || job.status === 'processing';

  const statusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <span className="text-muted-foreground">\u23F3</span>;
      case 'processing': return <span className="text-blue-500 animate-pulse">\uD83D\uDD04</span>;
      case 'completed': return <span className="text-green-600">\u2705</span>;
      case 'failed': return <span className="text-red-500">\u274C</span>;
      default: return null;
    }
  };

  const jobStatusBadge = () => {
    switch (job.status) {
      case 'pending': return <span className="inline-flex items-center rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200">Pending</span>;
      case 'processing': return <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800 dark:bg-blue-900/30 dark:text-blue-200">Processing</span>;
      case 'completed': return <span className="inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-200">Completed</span>;
      case 'partial': return <span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-800 dark:bg-orange-900/30 dark:text-orange-200">Partial</span>;
      case 'failed': return <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-200">Failed</span>;
    }
  };

  let lastProductName = '';
  let versionIndex = 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Progress</h3>
          {jobStatusBadge()}
        </div>
        {isActive && (
          <Button variant="destructive" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>

      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{processed}/{job.totalLineItems} completed {job.failedLineItems > 0 ? `(${job.failedLineItems} failed)` : ''}</span>
          <span>{Math.round(progress * 100)}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      <div className="max-h-48 overflow-y-auto rounded-lg border border-border">
        {job.lineItems.map((item, i) => {
          const isNewProduct = item.productName !== lastProductName;
          if (isNewProduct) {
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