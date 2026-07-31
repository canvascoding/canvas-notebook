'use client';

import { MonitorUp } from 'lucide-react';
import { useLocale } from 'next-intl';
import { useMemo } from 'react';

import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { Link } from '@/i18n/navigation';

type ChatLiveBrowserLinkProps = {
  agentId: string;
  runtimeStatus: RuntimeStatus | null;
  sessionId: string | null;
};

export function ChatLiveBrowserLink({
  agentId,
  runtimeStatus,
  sessionId,
}: ChatLiveBrowserLinkProps) {
  const locale = useLocale();
  const browser = runtimeStatus?.sessionId === sessionId && runtimeStatus.browser?.running
    ? runtimeStatus.browser
    : null;
  const label = locale === 'en' ? 'Open live browser' : 'Live-Browser öffnen';
  const details = browser?.activeTitle || browser?.activeUrl;
  const accessibleLabel = details ? `${label}: ${details}` : label;
  const href = useMemo(() => {
    const query = new URLSearchParams({ agentId, sessionId: sessionId || '' });
    return `/browser/live?${query.toString()}`;
  }, [agentId, sessionId]);

  if (!sessionId || !browser) return null;

  return (
    <Link
      href={href}
      data-testid="chat-live-browser-link"
      data-browser-control-mode={browser.controlMode}
      data-browser-tab-count={browser.tabCount}
      aria-label={accessibleLabel}
      title={accessibleLabel}
      className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
    >
      <MonitorUp aria-hidden="true" size={14} />
      <span className="hidden @[36rem]:inline">{label}</span>
      <span className="sr-only @[36rem]:hidden">{label}</span>
    </Link>
  );
}
