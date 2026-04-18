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
import { usePathname, useRouter } from '@/i18n/navigation';

interface WebSocketProviderProps {
  children: React.ReactNode;
}

type NotificationDetail = {
  sessionId: string;
  sessionTitle: string;
  notificationType: string;
  messagePreview?: string;
  lastMessageAt?: string;
  timestamp?: number;
};

function hasSessionCookie(): boolean {
  if (typeof document === 'undefined') return false;
  const cookies = document.cookie;
  return /(?:^|;\s*)better-auth\.session_token\s*=/.test(cookies)
    || /(?:^|;\s*)__Secure-better-auth\.session_token\s*=/.test(cookies);
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

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const t = useTranslations('chat');
  const clientRef = useRef<WebSocketClient | null>(null);
  const activeSessionRef = useRef<{ sessionId: string | null; isVisible: boolean }>({
    sessionId: null,
    isVisible: false,
  });
  const fallbackNotificationTimersRef = useRef<Map<string, number>>(new Map());
  const deliveredNotificationKeysRef = useRef<Map<string, number>>(new Map());
  const [, setConnected] = useState(false);
  const sessionBasePath = pathname.includes('/chat') ? pathname : '/notebook';

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

  const isActiveVisibleSession = useCallback((sessionId: string) => {
    const activeSession = activeSessionRef.current;
    return activeSession.isVisible && activeSession.sessionId === sessionId;
  }, []);

  const connectIfAuthenticated = useCallback(() => {
    const client = clientRef.current;
    if (!client) return;

    if (!hasSessionCookie()) {
      console.log('[WebSocketProvider] No session cookie, skipping WebSocket connection');
      return;
    }

    client.resetForReconnect();
    client.connect().catch((error) => {
      if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
        console.error('[WebSocketProvider] Failed to connect:', error);
      }
    });
  }, []);

  // Initialize WebSocket connection
  useEffect(() => {
    clientRef.current = getWebSocketClient();
    const client = clientRef.current;
    setConnected(client.isConnected());

    const handleConnected = () => {
      console.log('[WebSocketProvider] Connected');
      setConnected(true);
    };

    const handleDisconnected = () => {
      console.log('[WebSocketProvider] Disconnected');
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

    if (hasSessionCookie()) {
      client.connect().catch((error) => {
        if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
          console.error('[WebSocketProvider] Failed to connect:', error);
        }
      });
    }

    const handleAuthSuccess = () => {
      console.log('[WebSocketProvider] Session established, connecting WebSocket');
      connectIfAuthenticated();
    };

    window.addEventListener('ws-auth-success', handleAuthSuccess);

    return () => {
      client.removeEventListener('connected', handleConnected as EventListener);
      client.removeEventListener('disconnected', handleDisconnected as EventListener);
      client.removeEventListener('error', handleError as EventListener);
      window.removeEventListener('ws-auth-success', handleAuthSuccess);
      client.releaseConnection();
    };
  }, [connectIfAuthenticated]);

  useEffect(() => {
    const handleActiveSessionChanged = (event: CustomEvent<{ sessionId: string | null; isVisible: boolean }>) => {
      console.log(`[WebSocketProvider] Active session changed: sessionId=${event.detail.sessionId}, isVisible=${event.detail.isVisible}`);
      activeSessionRef.current = {
        sessionId: event.detail.sessionId,
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
      const { sessionId, sessionTitle, notificationType, messagePreview, lastMessageAt } = detail;
      const activeSession = activeSessionRef.current;
      console.log(`[WebSocketProvider] showSessionNotification called: sessionId=${sessionId}, type=${notificationType}, title="${sessionTitle}", activeSession=${activeSession.sessionId}, isVisible=${activeSession.isVisible}`);
      if (isActiveVisibleSession(sessionId)) {
        console.log(`[WebSocketProvider] SUPPRESSED: session ${sessionId} is active+visible, not showing toast`);
        clearFallbackNotificationTimer(sessionId);
        return;
      }

      const toastTitle = truncateText(sessionTitle, 60) || t('newChatTitle');
      const toastDescription = truncateText(messagePreview, 140) || t('newResponseReady');
      rememberDeliveredNotification(sessionId, lastMessageAt);
      clearFallbackNotificationTimer(sessionId);

      console.log(`[WebSocketProvider] SHOWING TOAST: sessionId=${sessionId}, type=${notificationType}, title="${toastTitle}", description="${toastDescription}"`);

      switch (notificationType) {
        case 'new_response':
          toast.info(toastTitle, {
            description: toastDescription,
            action: {
              label: t('openSession'),
              onClick: () => {
                router.push(`${sessionBasePath}?session=${encodeURIComponent(sessionId)}`);
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
            description: toastDescription || toastTitle,
            duration: 5000,
            position: 'top-right',
          });
          break;
      }
    };

    const handleNotification = (event: CustomEvent<NotificationDetail>) => {
      console.log(`[WebSocketProvider] handleNotification event received: sessionId=${event.detail.sessionId}, type=${event.detail.notificationType}`);
      showSessionNotification(event.detail);
    };

    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; lastMessageAt: string; title?: string }>) => {
      const { sessionId, lastMessageAt, title } = event.detail;
      const activeSession = activeSessionRef.current;
      console.log(`[WebSocketProvider] handleSessionUpdated: sessionId=${sessionId}, lastMessageAt=${lastMessageAt}, title="${title}", activeSession=${activeSession.sessionId}, isVisible=${activeSession.isVisible}`);

      if (isActiveVisibleSession(sessionId)) {
        console.log(`[WebSocketProvider] handleSessionUpdated SUPPRESSED: session ${sessionId} is active+visible`);
        clearFallbackNotificationTimer(sessionId);
        return;
      }

      clearFallbackNotificationTimer(sessionId);
      const timer = window.setTimeout(() => {
        const recentlyDeliveredAt = deliveredNotificationKeysRef.current.get(sessionId);
        if (recentlyDeliveredAt && Date.now() - recentlyDeliveredAt < 1500) {
          console.log(`[WebSocketProvider] Fallback timer: skipping session ${sessionId}, notification already delivered ${Date.now() - recentlyDeliveredAt}ms ago`);
          return;
        }

        console.log(`[WebSocketProvider] Fallback timer: showing notification for session ${sessionId} (no prior notification delivered)`);
        showSessionNotification({
          sessionId,
          sessionTitle: title || t('newChatTitle'),
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
  }, [clearFallbackNotificationTimer, isActiveVisibleSession, rememberDeliveredNotification, router, sessionBasePath, t]);

  return <>{children}</>;
}
