'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeStatus,
} from '@/app/lib/chat/runtime-status';
import { cn } from '@/lib/utils';
import { getContextStatusPresentation, shouldShowChatContextWarning } from './contextStatusDisplay';

export function ChatRuntimeNotice({ status }: { status: RuntimeStatus | null }) {
  const t = useTranslations('chat');
  const compactionStatus = status?.compactionStatus;
  const compactionKey = getRuntimeCompactionStatusTranslationKey(compactionStatus);
  const isCompacting = compactionStatus?.state === 'running';
  const hasCompactionProblem = Boolean(
    compactionStatus
    && !['idle', 'running', 'succeeded', 'no_op'].includes(compactionStatus.state),
  );
  const presentation = getContextStatusPresentation(status);
  const contextPressurePercent = presentation.percent;
  const contextWarningLevel = presentation.severity;
  // Context measurements are invalidated at durable message boundaries and
  // recomputed asynchronously. During a response this is an expected transient
  // state, not a new chat event. Only surface stable informational pressure once
  // the run is idle; real compaction work and failures remain visible.
  const showContextWarning = shouldShowChatContextWarning(status);

  if (!isCompacting && !hasCompactionProblem && !showContextWarning) {
    return null;
  }

  const label = isCompacting || hasCompactionProblem
    ? compactionKey ? t(compactionKey) : t('compactionStatusFailed')
    : presentation.blocking
      ? t('contextBudgetExceeded')
      : presentation.needsCompaction
        ? t('contextCompactionRequired', { percent: contextPressurePercent })
        : t(presentation.basis === 'trigger' ? 'contextUsageWarning' : 'contextBudgetWarning', { percent: contextPressurePercent });
  const isProblem = presentation.failed || presentation.blocking;

  return (
    <div className="flex justify-start px-1 py-1">
      <div
        data-testid="chat-runtime-notice"
        data-context-percent={contextPressurePercent}
        data-context-basis={presentation.basis}
        data-notice-kind={isCompacting ? 'compaction' : isProblem ? 'error' : contextWarningLevel ?? 'compaction'}
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
