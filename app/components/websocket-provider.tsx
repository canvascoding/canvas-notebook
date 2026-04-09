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

  // Initialize WebSocket connection
  useEffect(() => {
    clientRef.current = getWebSocketClient();
    const client = clientRef.current;

    const handleConnected = () => {
      console.log('[WebSocketProvider] Connected');
      setConnected(true);
    };

    const handleDisconnected = () => {
      console.log('[WebSocketProvider] Disconnected');
      setConnected(false);
    };

    const handleError = (event: CustomEvent<{ error: string; code?: string }>) => {
      console.error('[WebSocketProvider] Error:', event.detail);
    };

    client.addEventListener('connected', handleConnected as EventListener);
    client.addEventListener('disconnected', handleDisconnected as EventListener);
    client.addEventListener('error', handleError as EventListener);

    client.connect().catch(console.error);

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
      
      // Check if user is viewing THIS EXACT session
      const isViewingCurrentSession = currentSessionRef.current === sessionId;
      
      // Handle message_end event (AI response complete)
      if (agentEvent.type === 'message_end' && (agentEvent.message as Record<string, unknown>)?.role === 'assistant') {
        console.log('[WebSocketProvider] AI response complete in session:', sessionId);
        console.log('[WebSocketProvider] currentSessionRef:', currentSessionRef.current, 'event sessionId:', sessionId);
        console.log('[WebSocketProvider] isViewingCurrentSession:', isViewingCurrentSession);
        
        // Don't show toast if user is viewing THIS EXACT session
        if (isViewingCurrentSession) {
          console.log('[WebSocketProvider] User is viewing THIS session - suppressing toast');
          return;
        }

        // Check tab visibility and focus
        const isTabVisible = document.visibilityState === 'visible';
        const isTabFocused = document.hasFocus();

        // Only show toast if tab is visible AND focused
        if (isTabVisible && isTabFocused) {
          console.log('[WebSocketProvider] Showing toast for session', sessionId);
          toast.info(t('newResponseReady'), {
            description: sessionId, // TODO: Get session title from event
            action: {
              label: t('openSession'),
              onClick: () => {
                router.push(`/notebook?session=${sessionId}`);
              },
            },
            duration: 4000,
            position: 'top-right',
          });
        } else {
          console.log('[WebSocketProvider] Tab not visible/focused, suppressing toast');
        }
      }
    };

    const handleNotification = (event: CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string }>) => {
      const { sessionId, sessionTitle, notificationType } = event.detail;
      
      // Don't show notification if user is viewing THIS EXACT session
      const isViewingCurrentSession = currentSessionRef.current === sessionId;
      if (isViewingCurrentSession) {
        console.log('[WebSocketProvider] User viewing THIS session', sessionId, '- suppressing notification');
        return;
      }

      // Check tab visibility and focus
      const isTabVisible = document.visibilityState === 'visible';
      const isTabFocused = document.hasFocus();

      // Only show toast if tab is visible AND focused
      if (isTabVisible && isTabFocused) {
        console.log('[WebSocketProvider] Showing notification for session', sessionId);
        switch (notificationType) {
          case 'new_response':
            toast.info(t('newResponseReady'), {
              description: sessionTitle,
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
      } else {
        console.log('[WebSocketProvider] Tab not visible/focused, suppressing notification');
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
      delete (window as any).__websocketSubscribe;
      delete (window as any).__websocketUnsubscribe;
      delete (window as any).__setCurrentSession;
      delete (window as any).__setUserActive;
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
