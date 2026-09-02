'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { usePathname } from '@/i18n/navigation';
import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import { StudioRouteNav } from '@/app/apps/studio/components/StudioRouteNav';
import { useStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';
import { getStudioBackDestination } from '@/app/apps/studio/utils/studio-navigation';
import { WorkspaceSwitcher } from '@/app/components/workspaces/WorkspaceSwitcher';
import type { ChatRequestContext } from '@/app/lib/chat/types';

function isAspectRatioPath(pathname: string | null) {
  return Boolean(pathname?.startsWith('/studio/aspect-ratio'));
}

function getStudioTitle(pathname: string | null, tStudio: ReturnType<typeof useTranslations>) {
  if (pathname?.startsWith('/studio/aspect-ratio')) return tStudio('aspectRatioEditor.title');
  if (pathname?.startsWith('/studio/bulk')) return tStudio('tabs.bulk');
  if (pathname?.startsWith('/studio/models')) return tStudio('tabs.models');
  if (pathname?.startsWith('/studio/presets')) return tStudio('tabs.presets');
  return tStudio('title');
}

export function StudioShell({ children, hintEnabled = true }: { children: ReactNode; hintEnabled?: boolean }) {
  const tStudio = useTranslations('studio');
  const pathname = usePathname();
  const { chatContext } = useStudioChatContext();
  const isAspectRatioEditor = isAspectRatioPath(pathname);
  const chatVisibleStorageKey = isAspectRatioEditor ? 'studio.chatVisible.aspectRatio' : 'studio.chatVisible';
  const title = getStudioTitle(pathname, tStudio);
  const backDestination = getStudioBackDestination(pathname);
  const requestContext = useMemo<ChatRequestContext>(
    () => (chatContext?.currentPage === pathname ? chatContext : { currentPage: pathname ?? '/studio' }),
    [chatContext, pathname]
  );

  return (
    <ChatDockShell
      key={chatVisibleStorageKey}
      title={title}
      backHref={backDestination.href}
      preferBackFallback={backDestination.href !== '/'}
      requestContext={requestContext}
      storageKeyPrefix="studio"
      chatVisibleStorageKey={chatVisibleStorageKey}
      defaultChatVisible={!isAspectRatioEditor}
      headerCenter={<StudioRouteNav variant="desktop" />}
      headerActions={(
        <>
          <StudioRouteNav variant="mobile" />
          <WorkspaceSwitcher source="studio" variant="compact" />
        </>
      )}
      mainClassName="studio-touch-form-scope"
      hintPage="studio"
      hintEnabled={hintEnabled}
    >
      {children}
    </ChatDockShell>
  );
}
