'use client';

import { MonitorUp } from 'lucide-react';
import { useLocale } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { Link } from '@/i18n/navigation';

type ChatLiveBrowserLinkProps = {
  agentId: string;
  runtimeStatus: RuntimeStatus | null;
  sessionId: string | null;
};

type BrowserStatusResponse = {
  success?: boolean;
  data?: {
    toolAvailable?: boolean;
    profile?: { sessionRunning?: boolean };
  };
};

export function ChatLiveBrowserLink({
  agentId,
  runtimeStatus,
  sessionId,
}: ChatLiveBrowserLinkProps) {
  const locale = useLocale();
  const browserToolActive = runtimeStatus?.activeTool?.name === 'browser';
  const contextKey = `${agentId}:${sessionId || ''}`;
  const [browserState, setBrowserState] = useState({ contextKey, running: browserToolActive });
  const browserRunning = browserState.contextKey === contextKey ? browserState.running : browserToolActive;
  const label = locale === 'en' ? 'Open live browser' : 'Live-Browser öffnen';
  const href = useMemo(() => {
    const query = new URLSearchParams({ agentId, sessionId: sessionId || '' });
    return `/browser/live?${query.toString()}`;
  }, [agentId, sessionId]);

  useEffect(() => {
    if (!agentId || !sessionId) return;

    let cancelled = false;
    let controller: AbortController | null = null;
    let timer: number | null = null;

    const refresh = async () => {
      controller = new AbortController();
      try {
        const query = new URLSearchParams({ agentId, sessionId });
        const response = await fetch(`/api/agents/browser?${query.toString()}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = await response.json() as BrowserStatusResponse;
        if (!cancelled && response.ok && payload.success) {
          setBrowserState({
            contextKey,
            running: Boolean(payload.data?.toolAvailable && payload.data.profile?.sessionRunning),
          });
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) {
          // Keep the last known state during temporary status failures.
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void refresh(), 15_000);
      }
    };

    void refresh();
    return () => {
      cancelled = true;
      controller?.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [agentId, contextKey, sessionId]);

  if (!sessionId || (!browserRunning && !browserToolActive)) return null;

  return (
    <Link
      href={href}
      data-testid="chat-live-browser-link"
      aria-label={label}
      title={label}
      className="group inline-flex h-7 items-center gap-1.5 rounded-md border border-emerald-500/35 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 dark:text-emerald-300"
    >
      <MonitorUp aria-hidden="true" size={14} />
      <span className="hidden @[36rem]:inline">{label}</span>
      <span className="sr-only @[36rem]:hidden">{label}</span>
    </Link>
  );
}
