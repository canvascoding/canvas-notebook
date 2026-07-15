'use client';

import { History } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AISession } from '@/app/lib/chat/types';

export function ChatStarterScreen({
  latestSession,
  isStudioChatContext,
  onOpenLatestSession,
}: {
  latestSession: AISession | null;
  isStudioChatContext: boolean;
  onOpenLatestSession: () => void;
}) {
  const t = useTranslations('chat');

  return (
    <div className="flex min-h-full min-w-0 items-center justify-center py-8 md:py-0">
      <div className="mx-auto flex w-full max-w-xl min-w-0 flex-col items-center gap-3 px-4 text-center">
        <h2 className="max-w-lg break-words text-xl font-semibold tracking-tight text-foreground [overflow-wrap:anywhere] md:text-2xl">
          {t(isStudioChatContext ? 'studioStarterTitle' : 'starterTitle')}
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
