'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  getRuntimeCompactionStatusTranslationKey,
  type RuntimeStatus,
} from '@/app/lib/chat/runtime-status';
import { InlineNotice } from '@/components/ui/inline-notice';
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
      <InlineNotice
        data-testid="chat-runtime-notice"
        data-context-percent={contextPressurePercent}
        data-context-basis={presentation.basis}
        data-notice-kind={isCompacting ? 'compaction' : isProblem ? 'error' : contextWarningLevel ?? 'compaction'}
        role={isProblem ? 'alert' : 'status'}
        aria-live={isProblem ? 'assertive' : 'polite'}
        variant={isCompacting ? 'info' : isProblem ? 'destructive' : contextWarningLevel === 'warning' || hasCompactionProblem ? 'warning' : 'info'}
        size="compact"
        className="w-auto max-w-[90%]"
        icon={isCompacting
          ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          : <AlertTriangle aria-hidden="true" />}
      >
        {label}
      </InlineNotice>
    </div>
  );
}
