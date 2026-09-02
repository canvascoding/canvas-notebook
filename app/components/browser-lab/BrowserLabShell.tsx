'use client';

import { useMemo } from 'react';
import { BrowserLabClient } from '@/app/components/browser-lab/BrowserLabClient';
import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import type { ChatRequestContext } from '@/app/lib/chat/types';

type BrowserLabShellProps = {
  locale: string;
};

export function BrowserLabShell({ locale }: BrowserLabShellProps) {
  const requestContext = useMemo<ChatRequestContext>(() => ({
    currentPage: '/browser/lab',
  }), []);

  return (
    <ChatDockShell
      title={locale === 'en' ? 'Browser Lab' : 'Browser-Labor'}
      backHref="/"
      requestContext={requestContext}
      storageKeyPrefix="browserLab"
      defaultChatVisible
      headerActions={<WorkspaceSwitcher source="navbar" variant="compact" />}
      mainClassName="overflow-hidden"
      hintEnabled={false}
    >
      <BrowserLabClient locale={locale} embeddedChat />
    </ChatDockShell>
  );
}
