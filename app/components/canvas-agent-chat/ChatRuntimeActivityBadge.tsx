'use client';

import { useTranslations } from 'next-intl';
import { AgentIdentityIcon } from '@/app/components/agents/AgentIdentityVisual';
import { DEFAULT_AGENT_ID } from '@/app/lib/channels/constants';
import type { RuntimeStatus } from './runtime-status';

type ChatRuntimeActivityBadgeProps = {
  agentId: string;
  isPreparingResponse: boolean;
  status: RuntimeStatus | null;
  className?: string;
};

export function ChatRuntimeActivityBadge({
  agentId,
  isPreparingResponse,
  status,
  className,
}: ChatRuntimeActivityBadgeProps) {
  const t = useTranslations('chat');
  const phase = status?.phase ?? 'idle';
  const isWorking = phase !== 'idle';
  const isAborting = phase === 'aborting';
  const isBradley = agentId === DEFAULT_AGENT_ID;
  const showBradleyStatus = isBradley && isWorking && !isAborting;
  const label = isPreparingResponse
    ? t('preparingResponse')
    : !isWorking
      ? t('ready')
      : isAborting
        ? t('stopping')
        : t('working');
  const badgeClass = isWorking
    ? isAborting
      ? 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300'
      : 'border-amber-500/40 bg-amber-500/12 text-amber-700 dark:text-amber-300'
    : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
  const dotClass = isAborting ? 'bg-rose-500' : 'bg-amber-500';

  return (
    <span
      data-testid="chat-runtime-busy-badge"
      role="status"
      aria-live="polite"
      className={`inline-flex h-8 items-center gap-1.5 border px-2.5 py-0.5 text-[10px] font-medium ${badgeClass} ${className ?? ''}`}
    >
      {showBradleyStatus ? (
        <AgentIdentityIcon
          agentId={agentId}
          className="h-4 w-4"
          state={isPreparingResponse ? 'working' : 'idle'}
        />
      ) : isWorking ? (
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dotClass}`} />
      ) : null}
      {label}
    </span>
  );
}
