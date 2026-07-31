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
  const dismissedToolCallsRef = useRef(new Set<string>());
  const onOpenRef = useRef(onOpen);
  const scopeKeyRef = useRef(
    chatContext ? `${chatContext.agentId}:${chatContext.sessionId}` : null,
  );

  useEffect(() => {
    const nextScopeKey = chatContext
      ? `${chatContext.agentId}:${chatContext.sessionId}`
      : null;
    const scopeChanged = scopeKeyRef.current !== nextScopeKey;
    chatContextRef.current = chatContext;
    scopeKeyRef.current = nextScopeKey;
    if (!scopeChanged) return;

    dismissedToolCallsRef.current.clear();
    const timeout = window.setTimeout(() => {
      setContext({ email: null, browser: null });
    }, 0);
    return () => window.clearTimeout(timeout);
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
      if (
        intent.toolCallId
        && dismissedToolCallsRef.current.has(intent.toolCallId)
      ) {
        return;
      }

      setContext((current) => (
        intent.kind === 'email'
          ? { ...current, email: mergeIntent(current.email, intent) }
          : { ...current, browser: mergeIntent(current.browser, intent) }
      ));
      if (detail.event.type === 'tool_execution_start') {
        onOpenRef.current(intent.kind);
      }
    };

    window.addEventListener('agent_event', handleAgentEvent);
    return () => window.removeEventListener('agent_event', handleAgentEvent);
  }, []);

  const clearEmail = useCallback(() => {
    setContext((current) => {
      if (current.email?.toolCallId) {
        dismissedToolCallsRef.current.add(current.email.toolCallId);
      }
      return { ...current, email: null };
    });
  }, []);

  const clearBrowser = useCallback(() => {
    setContext((current) => {
      if (current.browser?.toolCallId) {
        dismissedToolCallsRef.current.add(current.browser.toolCallId);
      }
      return { ...current, browser: null };
    });
  }, []);

  return {
    emailContext: context.email,
    browserContext: context.browser,
    clearEmail,
    clearBrowser,
  };
}
