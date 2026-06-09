'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChatRequestContext } from '@/app/lib/chat/types';

type EmailChatContextValue = {
  chatContext: ChatRequestContext | null;
  setChatContext: (ctx: ChatRequestContext | null) => void;
};

const EmailChatContext = createContext<EmailChatContextValue | null>(null);

export function EmailChatProvider({ children }: { children: ReactNode }) {
  const [chatContext, setChatContextState] = useState<ChatRequestContext | null>(null);

  const setChatContext = useCallback((ctx: ChatRequestContext | null) => {
    setChatContextState(ctx);
  }, []);

  const value = useMemo(
    () => ({
      chatContext,
      setChatContext,
    }),
    [chatContext, setChatContext],
  );

  return <EmailChatContext.Provider value={value}>{children}</EmailChatContext.Provider>;
}

export function useEmailChatContext() {
  const context = useContext(EmailChatContext);

  if (!context) {
    throw new Error('useEmailChatContext must be used within EmailChatProvider');
  }

  return context;
}

export function useSetEmailChatContext() {
  return useEmailChatContext().setChatContext;
}
