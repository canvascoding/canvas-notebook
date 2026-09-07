'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ChatRequestContext } from '@/app/lib/chat/types';

type TodoChatContextValue = {
  chatContext: ChatRequestContext | null;
  setChatContext: (ctx: ChatRequestContext | null) => void;
};

const TodoChatContext = createContext<TodoChatContextValue | null>(null);

export function TodoChatProvider({ children }: { children: ReactNode }) {
  const [chatContext, setChatContextState] = useState<ChatRequestContext | null>(null);

  const setChatContext = useCallback((ctx: ChatRequestContext | null) => {
    setChatContextState(ctx);
  }, []);

  const value = useMemo(() => ({ chatContext, setChatContext }), [chatContext, setChatContext]);

  return <TodoChatContext.Provider value={value}>{children}</TodoChatContext.Provider>;
}

export function useTodoChatContext() {
  const context = useContext(TodoChatContext);

  if (!context) {
    throw new Error('useTodoChatContext must be used within TodoChatProvider');
  }

  return context;
}

export function useSetTodoChatContext() {
  return useTodoChatContext().setChatContext;
}
