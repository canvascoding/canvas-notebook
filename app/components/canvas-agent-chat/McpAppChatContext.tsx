'use client';

import { createContext, useContext } from 'react';

export type McpAppChatContextValue = { sessionId: string; agentId: string } | null;
export const McpAppChatContext = createContext<McpAppChatContextValue>(null);
export function useMcpAppChatContext() { return useContext(McpAppChatContext); }
