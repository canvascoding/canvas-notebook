/**
 * WebSocket Provider Wrapper for Server Component Layout
 */

'use client';

import { WebSocketProvider } from './websocket-provider';

export function WebsocketProviderWrapper({ children }: { children: React.ReactNode }) {
  return <WebSocketProvider>{children}</WebSocketProvider>;
}
