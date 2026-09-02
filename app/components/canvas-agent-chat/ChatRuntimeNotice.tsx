'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeStatus,
} from '@/app/lib/chat/runtime-status';
import { cn } from '@/lib/utils';

export function ChatRuntimeNotice({ status }: { status: RuntimeStatus | null }) {
  const t = useTranslations('chat');
  const compactionStatus = status?.compactionStatus;
  const compactionKey = getRuntimeCompactionStatusTranslationKey(compactionStatus);
  const isCompacting = compactionStatus?.state === 'running';
  const hasCompactionProblem = Boolean(
    compactionStatus
    && !['idle', 'running', 'succeeded', 'no_op'].includes(compactionStatus.state),
  );
  const contextPressurePercent = status?.contextPressure?.percentOfTrigger
    ?? status?.contextUsagePercent
    ?? 0;
  const contextWarningLevel = contextPressurePercent >= 95
    ? 'critical'
    : contextPressurePercent >= 80
      ? 'warning'
      : null;

  if (!isCompacting && !hasCompactionProblem && !contextWarningLevel) {
    return null;
  }

  const label = isCompacting || hasCompactionProblem
    ? compactionKey ? t(compactionKey) : t('compactionStatusFailed')
    : contextWarningLevel === 'critical'
      ? t('contextUsageCritical', { percent: contextPressurePercent })
      : t('contextUsageWarning', { percent: contextPressurePercent });
  const isProblem = hasCompactionProblem || contextWarningLevel === 'critical';

  return (
    <div className="flex justify-start px-1 py-1">
      <div
        data-testid="chat-runtime-notice"
        data-notice-kind={isCompacting ? 'compaction' : hasCompactionProblem ? 'error' : contextWarningLevel}
        role={isProblem ? 'alert' : 'status'}
        aria-live={isProblem ? 'assertive' : 'polite'}
        className={cn(
          'inline-flex max-w-[90%] items-center gap-2 rounded-md border px-2.5 py-2 text-xs shadow-sm',
          isProblem
            ? 'border-rose-500/30 bg-rose-500/10 text-rose-800 dark:text-rose-200'
            : contextWarningLevel === 'warning'
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
              : 'border-violet-500/30 bg-violet-500/10 text-violet-800 dark:text-violet-200',
        )}
      >
        {isCompacting ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        )}
        <span>{label}</span>
      </div>
    </div>
  );
}
