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
      
      // Check if user is viewing this session
      const isViewingCurrentSession = currentSessionRef.current === sessionId;
      
      // Handle message_end event (AI response complete)
      if (agentEvent.type === 'message_end' && (agentEvent.message as Record<string, unknown>)?.role === 'assistant') {
        console.log('[WebSocketProvider] AI response complete in session:', sessionId);
        
        // Don't show toast if user is viewing this session
        if (isViewingCurrentSession) {
          console.log('[WebSocketProvider] User is viewing session', sessionId, '- suppressing toast');
          return;
        }

        // Check tab visibility and focus
        const isTabVisible = document.visibilityState === 'visible';
        const isTabFocused = document.hasFocus();

        // Only show toast if tab is visible AND focused
        if (isTabVisible && isTabFocused) {
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
            closeButton: true,
          });
        } else {
          console.log('[WebSocketProvider] Tab not visible/focused, suppressing toast');
        }
      }
    };

    const handleNotification = (event: CustomEvent<{ sessionId: string; sessionTitle: string; notificationType: string }>) => {
      const { sessionId, sessionTitle, notificationType } = event.detail;
      
      // Don't show notification if user is viewing this session
      const isViewingCurrentSession = currentSessionRef.current === sessionId;
      if (isViewingCurrentSession) {
        console.log('[WebSocketProvider] User viewing session', sessionId, '- suppressing notification');
        return;
      }

      // Check tab visibility and focus
      const isTabVisible = document.visibilityState === 'visible';
      const isTabFocused = document.hasFocus();

      // Only show toast if tab is visible AND focused
      if (isTabVisible && isTabFocused) {
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
              closeButton: true,
            });
            break;

          case 'tool_complete':
            toast.success('Tool execution complete', {
              description: sessionTitle,
              duration: 3000,
              position: 'top-right',
              closeButton: true,
            });
            break;

          case 'error':
            toast.error('Error in session', {
              description: sessionTitle,
              duration: 5000,
              position: 'top-right',
              closeButton: true,
            });
            break;
        }
      } else {
        console.log('[WebSocketProvider] Tab not visible/focused, suppressing notification');
      }
    };

    window.addEventListener('agent_event', handleAgentEvent as EventListener);
    window.addEventListener('notification', handleNotification as EventListener);

    return () => {
      window.removeEventListener('agent_event', handleAgentEvent as EventListener);
      window.removeEventListener('notification', handleNotification as EventListener);
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

  return (
    <>
      {children}
      <div className="fixed bottom-4 right-4 z-50 text-xs text-muted-foreground">
        {connected ? (
          <span className="flex items-center gap-1 text-green-600">
            <span className="inline-block h-2 w-2 rounded-full bg-green-600 animate-pulse" />
            Connected
          </span>
        ) : (
          <span className="flex items-center gap-1 text-red-600">
            <span className="inline-block h-2 w-2 rounded-full bg-red-600" />
            Disconnected
          </span>
        )}
      </div>
    </>
  );
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
