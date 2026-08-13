/**
 * WebSocket Provider for Root Layout
 * 
 * Provides global WebSocket connection and toast notifications across all routes.
 * Only connects when a session cookie is present to avoid auth errors on public pages.
 */

'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { WebSocketClient, getWebSocketClient } from '@/app/lib/websocket/client';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { dispatchOpenChatSession } from '@/app/lib/chat/open-chat-session-event';
import {
  buildChatSessionHref,
  buildNotebookChatSessionHref,
} from '@/app/lib/chat/chat-navigation-intent';

interface WebSocketProviderProps {
  children: React.ReactNode;
  enabled?: boolean;
}

type NotificationDetail = {
  sessionId: string;
  sessionTitle: string;
  workspaceId?: string;
  notificationType: string;
  messagePreview?: string;
  lastMessageAt?: string;
  timestamp?: number;
};

type DesktopChatNotificationPayload = {
  sessionId: string;
  sessionTitle: string;
  workspaceId?: string;
  notificationType: string;
  messagePreview?: string;
  lastMessageAt?: string;
  targetPath: string;
};

type CanvasDesktopBridge = {
  showChatNotification?: (payload: DesktopChatNotificationPayload) => Promise<{
    ok: boolean;
    skippedReason?: string;
    error?: string;
  }>;
};

function hasSessionCookie(): boolean {
  if (typeof document === 'undefined') return false;
  const cookies = document.cookie;
  return /(?:^|;\s*)better-auth\.session_token\s*=/.test(cookies)
    || /(?:^|;\s*)__Secure-better-auth\.session_token\s*=/.test(cookies);
}

function getCanvasDesktopBridge(): CanvasDesktopBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as typeof window & { canvasDesktop?: CanvasDesktopBridge }).canvasDesktop;
  return candidate || null;
}

function shouldShowNativeNotification(): boolean {
  if (typeof document === 'undefined') return false;
  return document.hidden || !document.hasFocus();
}

function truncateText(value: string | null | undefined, maxLength: number): string {
  const normalized = (value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function pushCurrentChatSessionState(sessionId: string, workspaceId?: string) {
  if (typeof window === 'undefined') return;

  const nextPath = buildChatSessionHref(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    sessionId,
    workspaceId,
  );
  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (nextPath !== currentPath) {
    window.history.pushState({ sessionId, workspaceId, chat: 'open' }, '', nextPath);
  }
}

const toastHeadingClass = 'block font-semibold leading-snug text-foreground';

const toastMarkdownComponents = {
  p: ({ children }: { children?: React.ReactNode }) => <span className="inline">{children}</span>,
  h1: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  h2: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  h3: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  h4: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  h5: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  h6: ({ children }: { children?: React.ReactNode }) => <span className={toastHeadingClass}>{children}</span>,
  code: ({ children, className, ...props }: { children?: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLElement>) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return <code className="break-all rounded bg-muted px-1 py-0.5 text-xs font-mono whitespace-normal" {...props}>{children}</code>;
    }
    return <code className="break-all rounded bg-muted px-0.5 text-xs font-mono whitespace-normal" {...props}>{children}</code>;
  },
  pre: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  a: ({ children }: { children?: React.ReactNode }) => <span className="break-all underline">{children}</span>,
  img: ({ alt }: { alt?: string }) => alt ? <span>{alt}</span> : null,
  table: () => null,
  ul: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  ol: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  li: ({ children, ...props }: { children?: React.ReactNode } & React.HTMLAttributes<HTMLElement>) => <span {...props}>• {children} </span>,
  blockquote: ({ children }: { children?: React.ReactNode }) => <span className="opacity-70">{children}</span>,
  hr: () => <span className="mx-1">—</span>,
};

function ToastMarkdown({ content }: { content: string }) {
  if (!content) return null;

  return (
    <div className="line-clamp-3 min-w-0 max-w-full overflow-hidden break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={toastMarkdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

export function WebSocketProvider({ children, enabled = true }: WebSocketProviderProps) {
  const router = useRouter();
  const t = useTranslations('chat');
  const clientRef = useRef<WebSocketClient | null>(null);
  const hasConnectionLeaseRef = useRef(false);
  const activeSessionRef = useRef<{ sessionId: string | null; workspaceId: string | null; isVisible: boolean }>({
    sessionId: null,
    workspaceId: null,
    isVisible: false,
  });
  const fallbackNotificationTimersRef = useRef<Map<string, number>>(new Map());
  const deliveredNotificationKeysRef = useRef<Map<string, number>>(new Map());
  const [, setConnected] = useState(false);
  const getSessionTargetPath = useCallback((sessionId: string, workspaceId?: string) => {
    return buildNotebookChatSessionHref(sessionId, workspaceId);
  }, []);

  const clearFallbackNotificationTimer = useCallback((sessionId: string) => {
    const timer = fallbackNotificationTimersRef.current.get(sessionId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      fallbackNotificationTimersRef.current.delete(sessionId);
    }
  }, []);

  const rememberDeliveredNotification = useCallback((sessionId: string, lastMessageAt?: string) => {
    if (!lastMessageAt) {
      return;
    }

    deliveredNotificationKeysRef.current.set(sessionId, Date.now());
    window.setTimeout(() => {
      const storedAt = deliveredNotificationKeysRef.current.get(sessionId);
      if (storedAt && Date.now() - storedAt >= 5000) {
        deliveredNotificationKeysRef.current.delete(sessionId);
      }
    }, 5000);
  }, []);

  const isActiveVisibleSession = useCallback((sessionId: string, workspaceId?: string) => {
    const activeSession = activeSessionRef.current;
    return activeSession.isVisible
      && activeSession.sessionId === sessionId
      && (!workspaceId || !activeSession.workspaceId || activeSession.workspaceId === workspaceId);
  }, []);

  const connectIfAuthenticated = useCallback(() => {
    const client = clientRef.current;
    if (!client || !enabled) return;

    if (!hasSessionCookie()) {
      return;
    }

    client.resetForReconnect();
    const connection = hasConnectionLeaseRef.current
      ? client.ensureConnected()
      : client.acquireConnection();
    hasConnectionLeaseRef.current = true;
    connection.catch((error) => {
      if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
        console.error('[WebSocketProvider] Failed to connect:', error);
      }
    });
  }, [enabled]);

  // Initialize WebSocket connection
  useEffect(() => {
    clientRef.current = getWebSocketClient();
    const client = clientRef.current;
    setConnected(client.isConnected());

    if (!enabled) setConnected(false);

    const handleConnected = () => {
      setConnected(true);
    };

    const handleDisconnected = () => {
      setConnected(false);
    };

    const handleError = (event: CustomEvent<{ error: string; code?: string }>) => {
      if (event.detail.code === 'AUTH_ERROR') {
        window.dispatchEvent(new CustomEvent('ws-auth-error'));
        return;
      }

      console.error('[WebSocketProvider] Error:', event.detail);
    };

    client.addEventListener('connected', handleConnected as EventListener);
    client.addEventListener('disconnected', handleDisconnected as EventListener);
    client.addEventListener('error', handleError as EventListener);

    if (enabled && hasSessionCookie()) {
      hasConnectionLeaseRef.current = true;
      client.acquireConnection().catch((error) => {
        if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
          console.error('[WebSocketProvider] Failed to connect:', error);
        }
      });
    }

    const handleAuthSuccess = () => {
      connectIfAuthenticated();
    };

    window.addEventListener('ws-auth-success', handleAuthSuccess);

    return () => {
      client.removeEventListener('connected', handleConnected as EventListener);
      client.removeEventListener('disconnected', handleDisconnected as EventListener);
      client.removeEventListener('error', handleError as EventListener);
      window.removeEventListener('ws-auth-success', handleAuthSuccess);
      if (hasConnectionLeaseRef.current) {
        hasConnectionLeaseRef.current = false;
        client.releaseConnection();
      }
    };
  }, [connectIfAuthenticated, enabled]);

  useEffect(() => {
    const handleActiveSessionChanged = (event: CustomEvent<{ sessionId: string | null; workspaceId?: string | null; isVisible: boolean }>) => {
      activeSessionRef.current = {
        sessionId: event.detail.sessionId,
        workspaceId: event.detail.workspaceId ?? null,
        isVisible: event.detail.isVisible,
      };
    };

    window.addEventListener('chat-active-session-changed', handleActiveSessionChanged as EventListener);
    return () => {
      window.removeEventListener('chat-active-session-changed', handleActiveSessionChanged as EventListener);
    };
  }, []);

  // Handle notification and auth error events
  useEffect(() => {
    const fallbackTimers = fallbackNotificationTimersRef.current;

    const showSessionNotification = (detail: NotificationDetail) => {
      const { sessionId, sessionTitle, workspaceId, notificationType, messagePreview, lastMessageAt } = detail;
      if (isActiveVisibleSession(sessionId, workspaceId)) {
        clearFallbackNotificationTimer(sessionId);
        return;
      }

      const toastTitle = truncateText(sessionTitle, 60) || t('newChatTitle');
      const toastDescription = messagePreview || t('newResponseReady');
      const targetPath = getSessionTargetPath(sessionId, workspaceId);
      rememberDeliveredNotification(sessionId, lastMessageAt);
      clearFallbackNotificationTimer(sessionId);

      const desktopBridge = getCanvasDesktopBridge();
      if (
        desktopBridge?.showChatNotification &&
        shouldShowNativeNotification() &&
        (notificationType === 'new_response' || notificationType === 'error')
      ) {
        void desktopBridge.showChatNotification({
          sessionId,
          sessionTitle: toastTitle,
          workspaceId,
          notificationType,
          messagePreview: toastDescription,
          lastMessageAt,
          targetPath,
        }).catch((error) => {
          console.error('[WebSocketProvider] Native notification failed:', error);
        });
      }

      switch (notificationType) {
        case 'new_response':
          toast.info(toastTitle, {
            description: <ToastMarkdown content={toastDescription} />,
            action: {
              label: t('openSession'),
              onClick: () => {
                pushCurrentChatSessionState(sessionId, workspaceId);
                if (dispatchOpenChatSession(sessionId, 'notification', workspaceId)) {
                  return;
                }
                router.push(targetPath);
              },
            },
            duration: 4000,
            position: 'top-right',
          });
          break;

        case 'tool_complete':
          toast.success('Tool execution complete', {
            description: toastTitle,
            duration: 3000,
            position: 'top-right',
          });
          break;

        case 'error':
          toast.error('Error in session', {
            description: <ToastMarkdown content={toastDescription || toastTitle} />,
            duration: 5000,
            position: 'top-right',
          });
          break;
      }
    };

    const handleNotification = (event: CustomEvent<NotificationDetail>) => {
      showSessionNotification(event.detail);
    };

    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; workspaceId?: string; lastMessageAt: string; title?: string }>) => {
      const { sessionId, workspaceId, lastMessageAt, title } = event.detail;

      if (isActiveVisibleSession(sessionId, workspaceId)) {
        clearFallbackNotificationTimer(sessionId);
        return;
      }

      clearFallbackNotificationTimer(sessionId);
      const timer = window.setTimeout(() => {
        const recentlyDeliveredAt = deliveredNotificationKeysRef.current.get(sessionId);
        if (recentlyDeliveredAt && Date.now() - recentlyDeliveredAt < 1500) {
          return;
        }

        showSessionNotification({
          sessionId,
          sessionTitle: title || t('newChatTitle'),
          workspaceId,
          notificationType: 'new_response',
          lastMessageAt,
        });
      }, 180);

      fallbackNotificationTimersRef.current.set(sessionId, timer);
    };

    // Handle AUTH_ERROR: show toast and offer redirect to sign-in
    const handleAuthError = () => {
      toast.error(t('authError'), {
        description: t('authErrorDescription'),
        action: {
          label: t('loginAgain'),
          onClick: () => router.push('/sign-in' as Parameters<typeof router.push>[0]),
        },
        duration: 8000,
        position: 'top-right',
      });
    };

    window.addEventListener('notification', handleNotification as EventListener);
    window.addEventListener('session_updated', handleSessionUpdated as EventListener);
    window.addEventListener('ws-auth-error', handleAuthError);

    return () => {
      fallbackTimers.forEach((timer) => window.clearTimeout(timer));
      fallbackTimers.clear();
      window.removeEventListener('notification', handleNotification as EventListener);
      window.removeEventListener('session_updated', handleSessionUpdated as EventListener);
      window.removeEventListener('ws-auth-error', handleAuthError);
    };
  }, [clearFallbackNotificationTimer, getSessionTargetPath, isActiveVisibleSession, rememberDeliveredNotification, router, t]);

  return <>{children}</>;
}
