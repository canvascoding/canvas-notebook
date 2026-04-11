/**
 * WebSocket Provider for Root Layout
 * 
 * Provides global WebSocket connection and toast notifications across all routes.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { WebSocketClient, getWebSocketClient } from '@/app/lib/websocket/client';
import { toast } from 'sonner';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

interface WebSocketProviderProps {
  children: React.ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const router = useRouter();
  const t = useTranslations('chat');
  const currentSessionRef = useRef<string | null>(null);
  const isUserActiveRef = useRef(false);
  const clientRef = useRef<WebSocketClient | null>(null);
  const [connected, setConnected] = useState(false);
  const broadcastChannelRef = useRef<BroadcastChannel | null>(null);

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

  // Initialize BroadcastChannel for cross-tab notifications
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      broadcastChannelRef.current = new BroadcastChannel('canvas-notifications');
      
      // Listen for notifications from other tabs
      broadcastChannelRef.current.onmessage = (event) => {
        const { sessionId, sessionTitle, notificationType, messagePreview } = event.data;
        
        // Check if this tab is viewing the session AND is focused
        const isViewingThisSession = currentSessionRef.current === sessionId;
        const isTabFocused = document.hasFocus();
        const isTabVisible = document.visibilityState === 'visible';
        
        // Suppress only if viewing session in focused tab
        if (isViewingThisSession && isTabFocused && isTabVisible) {
          return;
        }
        
        // Show toast (same logic as handleNotification)
        const truncatedTitle = sessionTitle?.length > 30 ? sessionTitle.slice(0, 30) + '...' : sessionTitle;
        
        switch (notificationType) {
          case 'new_response':
            toast.info(truncatedTitle, {
              description: messagePreview || t('newResponseReady'),
              action: {
                label: t('openSession'),
                onClick: () => {
                  router.push(`/notebook?session=${sessionId}`);
                },
              },
              duration: 4000,
              position: 'top-right',
            });
            break;

          case 'tool_complete':
            toast.success('Tool execution complete', {
              description: sessionTitle,
              duration: 3000,
              position: 'top-right',
            });
            break;

          case 'error':
            toast.error('Error in session', {
              description: sessionTitle,
              duration: 5000,
              position: 'top-right',
            });
            break;
        }
      };
    }

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

    const handleNotification = (event: CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string; messagePreview?: string }>) => {
      const { sessionId, sessionTitle, notificationType, messagePreview } = event.detail;
      
      // Check if this tab is viewing the session AND is focused
      const isViewingThisSession = currentSessionRef.current === sessionId;
      const isTabFocused = document.hasFocus();
      const isTabVisible = document.visibilityState === 'visible';
      
      // Suppress toast only if:
      // 1. This tab is viewing the session AND
      // 2. The tab is focused AND visible
      if (isViewingThisSession && isTabFocused && isTabVisible) {
        console.log('[WebSocketProvider] User viewing session', sessionId, 'in focused tab - suppressing notification');
        return;
      }

      // Show toast in all other cases (different session OR tab not focused)
      console.log('[WebSocketProvider] Showing notification for session', sessionId);
      
      // Truncate session title for mobile-friendly display
      const truncatedTitle = sessionTitle.length > 30 ? sessionTitle.slice(0, 30) + '...' : sessionTitle;
      
      switch (notificationType) {
        case 'new_response':
          toast.info(truncatedTitle, {
            description: messagePreview || t('newResponseReady'),
            action: {
              label: t('openSession'),
              onClick: () => {
                router.push(`/notebook?session=${sessionId}`);
              },
            },
            duration: 4000,
            position: 'top-right',
          });
          break;

        case 'tool_complete':
          toast.success('Tool execution complete', {
            description: sessionTitle,
            duration: 3000,
            position: 'top-right',
          });
          break;

        case 'error':
          toast.error('Error in session', {
            description: sessionTitle,
            duration: 5000,
            position: 'top-right',
          });
          break;
      }
    };

    // Broadcast notifications to other tabs
      if (broadcastChannelRef.current) {
        broadcastChannelRef.current.postMessage({
          sessionId,
          sessionTitle,
          notificationType,
          messagePreview,
        });
      }

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
      
      // Cleanup BroadcastChannel
      if (broadcastChannelRef.current) {
        broadcastChannelRef.current.close();
        broadcastChannelRef.current = null;
      }
    };
  }, [connected, router, t]);

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
