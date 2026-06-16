'use client';

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';

import { usePathname } from '@/i18n/navigation';
import { ChatDockShell } from '@/app/components/layout/ChatDockShell';
import { StudioRouteNav } from '@/app/apps/studio/components/StudioRouteNav';
import { useStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';
import type { ChatRequestContext } from '@/app/lib/chat/types';

function isAspectRatioPath(pathname: string | null) {
  return Boolean(pathname?.startsWith('/studio/aspect-ratio'));
}

function getBackHref(pathname: string | null) {
  if (pathname?.match(/^\/studio\/models\/[^/]+$/)) {
    return '/studio/models';
  }
  if (pathname?.match(/^\/studio\/presets\/[^/]+$/)) {
    return '/studio/presets';
  }
  if (pathname?.match(/^\/studio\/products\/[^/]+$/)) {
    return '/studio/products';
  }
  if (pathname?.match(/^\/studio\/personas\/[^/]+$/)) {
    return '/studio/personas';
  }
  if (pathname?.startsWith('/studio/')) {
    return '/studio';
  }
  return '/';
}

function getStudioTitle(pathname: string | null, tStudio: ReturnType<typeof useTranslations>) {
  if (pathname?.startsWith('/studio/aspect-ratio')) return tStudio('aspectRatioEditor.title');
  if (pathname?.startsWith('/studio/bulk')) return tStudio('tabs.bulk');
  if (pathname?.startsWith('/studio/models')) return tStudio('tabs.models');
  if (pathname?.startsWith('/studio/presets')) return tStudio('tabs.presets');
  return tStudio('title');
}

export function StudioShell({ children, hintEnabled = true }: { children: ReactNode; hintEnabled?: boolean }) {
  const tCommon = useTranslations('common');
  const tStudio = useTranslations('studio');
  const pathname = usePathname();
  const { chatContext } = useStudioChatContext();
  const isAspectRatioEditor = isAspectRatioPath(pathname);
  const chatVisibleStorageKey = isAspectRatioEditor ? 'studio.chatVisible.aspectRatio' : 'studio.chatVisible';
  const title = getStudioTitle(pathname, tStudio);
  const backLabel = pathname?.startsWith('/studio/') ? tStudio('title') : tCommon('suite');
  const requestContext = useMemo<ChatRequestContext>(
    () => (chatContext?.currentPage === pathname ? chatContext : { currentPage: pathname ?? '/studio' }),
    [chatContext, pathname]
  );

  return (
    <ChatDockShell
      key={chatVisibleStorageKey}
      title={title}
      backHref={getBackHref(pathname)}
      backLabel={backLabel}
      requestContext={requestContext}
      storageKeyPrefix="studio"
      chatVisibleStorageKey={chatVisibleStorageKey}
      defaultChatVisible={!isAspectRatioEditor}
      headerCenter={<StudioRouteNav variant="desktop" />}
      headerActions={<StudioRouteNav variant="mobile" />}
      hintPage="studio"
      hintEnabled={hintEnabled}
    >
      {children}
    </ChatDockShell>
  );
}
