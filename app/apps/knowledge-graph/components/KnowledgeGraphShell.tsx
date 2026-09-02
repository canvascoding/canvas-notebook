'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { KnowledgeGraphClient } from './KnowledgeGraphClient';
import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { usePathname } from '@/i18n/navigation';

export function KnowledgeGraphShell() {
  const t = useTranslations('knowledgeGraph');
  const pathname = usePathname();
  const requestContext = useMemo<ChatRequestContext>(() => ({
    currentPage: pathname ?? '/knowledge-graph',
  }), [pathname]);

  return (
    <ChatDockShell
      title={t('title')}
      backHref="/"
      requestContext={requestContext}
      storageKeyPrefix="knowledgeGraph"
      hintPage="knowledge-graph"
      defaultChatVisible={false}
      headerActions={<WorkspaceSwitcher source="navbar" variant="compact" />}
      mainClassName="overflow-hidden"
      titleClassName="font-mono uppercase tracking-[0.12em]"
    >
      <KnowledgeGraphClient />
    </ChatDockShell>
  );
}
