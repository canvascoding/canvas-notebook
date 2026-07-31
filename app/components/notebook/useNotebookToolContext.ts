'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatEvent } from '@/app/lib/chat/types';
import {
  notebookContextIntentFromAgentEvent,
  type NotebookBrowserContextIntent,
  type NotebookChatContext,
  type NotebookContextIntent,
  type NotebookEmailContextIntent,
} from '@/app/lib/notebook/context-surface';

type ToolContextState = {
  email: NotebookEmailContextIntent | null;
  browser: NotebookBrowserContextIntent | null;
};

function mergeIntent<T extends NotebookContextIntent>(current: T | null, next: T): T {
  if (!current || current.toolCallId !== next.toolCallId) return next;
  return {
    ...current,
    ...Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined),
    ),
  } as T;
}

export function useNotebookToolContext({
  chatContext,
  onOpen,
}: {
  chatContext: NotebookChatContext | null;
  onOpen: (surface: NotebookContextIntent['kind']) => void;
}) {
  const [context, setContext] = useState<ToolContextState>({
    email: null,
    browser: null,
  });
  const chatContextRef = useRef(chatContext);
  const onOpenRef = useRef(onOpen);

  useEffect(() => {
    chatContextRef.current = chatContext;
  }, [chatContext]);

  useEffect(() => {
    onOpenRef.current = onOpen;
  }, [onOpen]);

  useEffect(() => {
    const handleAgentEvent = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string;
        event?: ChatEvent;
      }>).detail;
      const activeChatContext = chatContextRef.current;
      if (
        !activeChatContext
        || detail?.sessionId !== activeChatContext.sessionId
        || !detail.event
      ) {
        return;
      }

      const intent = notebookContextIntentFromAgentEvent(detail.event, activeChatContext);
      if (!intent) return;

      setContext((current) => (
        intent.kind === 'email'
          ? { ...current, email: mergeIntent(current.email, intent) }
          : { ...current, browser: mergeIntent(current.browser, intent) }
      ));
      onOpenRef.current(intent.kind);
    };

    window.addEventListener('agent_event', handleAgentEvent);
    return () => window.removeEventListener('agent_event', handleAgentEvent);
  }, []);

  const clearEmail = useCallback(() => {
    setContext((current) => ({ ...current, email: null }));
  }, []);

  const clearBrowser = useCallback(() => {
    setContext((current) => ({ ...current, browser: null }));
  }, []);

  return {
    emailContext: context.email,
    browserContext: context.browser,
    clearEmail,
    clearBrowser,
  };
}
