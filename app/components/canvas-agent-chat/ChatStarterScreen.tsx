'use client';

import { History } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Image from 'next/image';

import { isMainAgentId } from '@/app/lib/agents/main-agent';
import type { AISession } from '@/app/lib/chat/types';

export function ChatStarterScreen({
  activeAgentDisplayName,
  activeAgentId,
  latestSession,
  isStudioChatContext,
  onOpenLatestSession,
}: {
  activeAgentDisplayName: string;
  activeAgentId: string;
  latestSession: AISession | null;
  isStudioChatContext: boolean;
  onOpenLatestSession: () => void;
}) {
  const t = useTranslations('chat');
  const showBradley = isMainAgentId(activeAgentId) && !isStudioChatContext;
  const starterTitle = isStudioChatContext
    ? t('studioStarterTitle')
    : showBradley
      ? t('bradleyStarterTitle')
      : t('agentStarterTitle', { agentName: activeAgentDisplayName });

  return (
    <div className="flex min-h-full min-w-0 items-center justify-center py-8 md:py-0">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col items-center gap-3 px-4 text-center">
        {showBradley ? (
          <div className="flex flex-col items-center gap-1.5" data-testid="bradley-starter-identity">
            <Image
              src="/images/bradley/bradley-character-starter.png"
              alt=""
              aria-hidden="true"
              width={160}
              height={160}
              sizes="160px"
              className="h-32 w-32 select-none object-contain md:h-36 md:w-36"
              priority={false}
            />
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
              {t('bradleyStarterEyebrow')}
            </span>
          </div>
        ) : null}
        <h2 className="max-w-lg break-words text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere] md:text-2xl">
          {starterTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{t('starterPromptHint')}</p>
        {latestSession ? (
          <button
            type="button"
            data-testid="chat-open-latest-session"
            onClick={onOpenLatestSession}
            className="mt-2 inline-flex max-w-full min-w-0 items-center gap-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <History className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">{t('openLatestSession')}</span>
            <span className="max-w-[14rem] truncate">{latestSession.title || latestSession.sessionId}</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
