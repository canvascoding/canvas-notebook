'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChatRequestContext } from '@/app/lib/chat/types';

type StudioChatContextValue = {
  chatContext: ChatRequestContext | null;
  setChatContext: (ctx: ChatRequestContext | null) => void;
};

const StudioChatContext = createContext<StudioChatContextValue | null>(null);

export function StudioChatProvider({ children }: { children: ReactNode }) {
  const [chatContext, setChatContextState] = useState<ChatRequestContext | null>(null);

  const setChatContext = useCallback((ctx: ChatRequestContext | null) => {
    setChatContextState(ctx);
  }, []);

  const value = useMemo(
    () => ({
      chatContext,
      setChatContext,
    }),
    [chatContext, setChatContext]
  );

  return <StudioChatContext.Provider value={value}>{children}</StudioChatContext.Provider>;
}

export function useStudioChatContext() {
  const context = useContext(StudioChatContext);

  if (!context) {
    throw new Error('useStudioChatContext must be used within StudioChatProvider');
  }

  return context;
}

export function useSetStudioChatContext() {
  return useStudioChatContext().setChatContext;
}
