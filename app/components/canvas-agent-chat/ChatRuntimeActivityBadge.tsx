'use client';

import { useTranslations } from 'next-intl';
import type { RuntimeStatus } from './runtime-status';

type ChatRuntimeActivityBadgeProps = {
  status: RuntimeStatus | null;
  className?: string;
};

export function ChatRuntimeActivityBadge({ status, className }: ChatRuntimeActivityBadgeProps) {
  const t = useTranslations('chat');
  const phase = status?.phase ?? 'idle';
  const isWorking = phase !== 'idle';
  const isAborting = phase === 'aborting';
  const label = !isWorking ? t('ready') : isAborting ? t('stopping') : t('working');
  const badgeClass = isWorking
    ? isAborting
      ? 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300'
      : 'border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const dotClass = `${isAborting ? 'bg-rose-500' : 'bg-amber-500'} animate-pulse`;

  return (
    <span
      data-testid="chat-runtime-busy-badge"
      aria-live="polite"
      className={`inline-flex h-8 items-center gap-1.5 border px-2.5 py-0.5 text-[10px] font-medium ${badgeClass} ${className ?? ''}`}
    >
      {isWorking ? <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotClass}`} /> : null}
      {label}
    </span>
  );
}
