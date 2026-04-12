/**
 * WebSocket Provider for Root Layout
 * 
 * Provides global WebSocket connection and toast notifications across all routes.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
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
};

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
  const currentSessionRef = useRef<string | null>(null);
  const isUserActiveRef = useRef(false);
  const clientRef = useRef<WebSocketClient | null>(null);
  const [connected, setConnected] = useState(false);
  const sessionBasePath = pathname.includes('/chat') ? pathname : '/notebook';

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
        console.warn('[WebSocketProvider] WebSocket auth unavailable:', event.detail.error);
        return;
      }

      console.error('[WebSocketProvider] Error:', event.detail);
    };

    client.addEventListener('connected', handleConnected as EventListener);
    client.addEventListener('disconnected', handleDisconnected as EventListener);
    client.addEventListener('error', handleError as EventListener);

    client.connect().catch((error) => {
      if ((error as { code?: string })?.code !== 'AUTH_ERROR') {
        console.error('[WebSocketProvider] Failed to connect:', error);
      }
    });

    return () => {
      client.removeEventListener('connected', handleConnected as EventListener);
      client.removeEventListener('disconnected', handleDisconnected as EventListener);
      client.removeEventListener('error', handleError as EventListener);
      client.disconnect();
    };
  }, []);

  // Handle agent events
  useEffect(() => {
    if (!connected) return;

    const handleAgentEvent = (event: CustomEvent<{ sessionId: string; event: Record<string, unknown> }>) => {
      const { sessionId, event: agentEvent } = event.detail;
      
      // Note: Toasts are handled by the 'notification' event, not by agent_event
      // This handler only logs the event for debugging purposes
      if (agentEvent.type === 'message_end' && (agentEvent.message as Record<string, unknown>)?.role === 'assistant') {
        console.log('[WebSocketProvider] AI response complete in session:', sessionId);
        console.log('[WebSocketProvider] Toast will be shown via notification event');
      }
    };

    const handleNotification = (event: CustomEvent<NotificationDetail>) => {
      const { sessionId, sessionTitle, notificationType, messagePreview } = event.detail;
      const isViewingThisSession = currentSessionRef.current === sessionId;
      const isActivelyViewingThisSession =
        isViewingThisSession &&
        isUserActiveRef.current &&
        document.hasFocus() &&
        document.visibilityState === 'visible';

      if (isActivelyViewingThisSession) {
        console.log('[WebSocketProvider] User viewing session', sessionId, 'in focused tab - suppressing notification');
        return;
      }

      console.log('[WebSocketProvider] Showing notification for session', sessionId);
      const toastTitle = truncateText(sessionTitle, 60) || t('newChatTitle');
      const toastDescription = truncateText(messagePreview, 140) || t('newResponseReady');
      
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

    // Handle session_updated events (for updating history unread status)
    const handleSessionUpdated = (event: CustomEvent<{ sessionId: string; lastMessageAt: string }>) => {
      const { sessionId, lastMessageAt } = event.detail;
      console.log('[WebSocketProvider] Session updated:', sessionId, lastMessageAt);
      
      // Dispatch custom event for CanvasAgentChat to update history
      window.dispatchEvent(new CustomEvent('session-updated', {
        detail: { sessionId, lastMessageAt }
      }));
    };

    window.addEventListener('agent_event', handleAgentEvent as EventListener);
    window.addEventListener('notification', handleNotification as EventListener);
    window.addEventListener('session_updated', handleSessionUpdated as EventListener);

    return () => {
      window.removeEventListener('agent_event', handleAgentEvent as EventListener);
      window.removeEventListener('notification', handleNotification as EventListener);
      window.removeEventListener('session_updated', handleSessionUpdated as EventListener);
    };
  }, [connected, router, sessionBasePath, t]);

  // Expose subscription methods globally for components to use
  useEffect(() => {
    window.__websocketSubscribe = (sessionId: string) => {
      clientRef.current?.subscribe(sessionId);
    };
    window.__websocketUnsubscribe = (sessionId: string) => {
      clientRef.current?.unsubscribe(sessionId);
    };
    window.__setCurrentSession = (sessionId: string | null) => {
      currentSessionRef.current = sessionId;
    };
    window.__setUserActive = (isActive: boolean) => {
      isUserActiveRef.current = isActive;
    };

    return () => {
      delete window.__websocketSubscribe;
      delete window.__websocketUnsubscribe;
      delete window.__setCurrentSession;
      delete window.__setUserActive;
    };
  }, []);

  return <>{children}</>;
}

// Global types for window extensions
declare global {
  interface Window {
    __websocketSubscribe?: (sessionId: string) => void;
    __websocketUnsubscribe?: (sessionId: string) => void;
    __setCurrentSession?: (sessionId: string | null) => void;
    __setUserActive?: (isActive: boolean) => void;
  }
}
