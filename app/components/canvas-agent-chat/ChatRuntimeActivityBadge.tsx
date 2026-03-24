'use client';

import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from './runtime-status';

type ChatRuntimeActivityBadgeProps = {
  status: RuntimeStatus | null;
};

export function ChatRuntimeActivityBadge({ status }: ChatRuntimeActivityBadgeProps) {
  const t = useTranslations('chat');
  const isWorking = Boolean(status && status.phase !== 'idle');
  const label = isWorking ? t('working') : t('ready');
  const badgeClass = isWorking
    ? 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const dotClass = 'bg-rose-500 animate-pulse';

  return (
    <span
      data-testid="chat-runtime-busy-badge"
      aria-live="polite"
      className={`inline-flex items-center gap-1.5 border px-2.5 py-0.5 text-[10px] font-medium ${badgeClass}`}
    >
      {isWorking ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotClass}`} /> : null}
      {label}
    </span>
  );
}
