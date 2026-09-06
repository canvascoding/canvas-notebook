'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ChatEvent } from '@/app/lib/chat/types';
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
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
  runtimeStatus,
  onOpen,
  onClose,
}: {
  chatContext: NotebookChatContext | null;
  runtimeStatus: RuntimeStatus | null;
  onOpen: (surface: NotebookContextIntent['kind']) => void;
  onClose: (surface: NotebookContextIntent['kind']) => void;
}) {
  const [context, setContext] = useState<ToolContextState>({
    email: null,
    browser: null,
  });
  const chatContextRef = useRef(chatContext);
  const dismissedToolCallsRef = useRef(new Set<string>());
  const browserRevisionRef = useRef<number | null>(null);
  const browserDismissedRef = useRef(false);
  const dismissedBrowserToolCallIdRef = useRef<string | null>(null);
  const browserSnapshotRef = useRef<NonNullable<RuntimeStatus['browser']> | null>(null);
  const browserActiveToolRef = useRef<RuntimeStatus['activeTool']>(null);
  const browserIntentRevisionRef = useRef(0);
  const scopeResetTimerRef = useRef<number | null>(null);
  const onOpenRef = useRef(onOpen);
  const onCloseRef = useRef(onClose);
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
    browserRevisionRef.current = null;
    browserDismissedRef.current = false;
    dismissedBrowserToolCallIdRef.current = null;
    browserSnapshotRef.current = null;
    browserActiveToolRef.current = null;
    browserIntentRevisionRef.current += 1;
    onCloseRef.current('email');
    onCloseRef.current('browser');
    if (scopeResetTimerRef.current !== null) {
      window.clearTimeout(scopeResetTimerRef.current);
    }
    scopeResetTimerRef.current = window.setTimeout(() => {
      scopeResetTimerRef.current = null;
      setContext({ email: null, browser: null });
    }, 0);
    return () => {
      if (scopeResetTimerRef.current !== null) {
        window.clearTimeout(scopeResetTimerRef.current);
        scopeResetTimerRef.current = null;
      }
    };
  }, [chatContext]);

  useEffect(() => {
    onOpenRef.current = onOpen;
    onCloseRef.current = onClose;
  }, [onClose, onOpen]);

  useEffect(() => {
    if (!chatContext || !runtimeStatus || runtimeStatus.sessionId !== chatContext.sessionId) {
      return;
    }

    const snapshot = runtimeStatus.browser;
    browserActiveToolRef.current = runtimeStatus.activeTool?.name === 'browser'
      ? runtimeStatus.activeTool
      : null;
    if (!snapshot?.running) {
      browserSnapshotRef.current = null;
      const timeout = window.setTimeout(() => {
        const browserWasActive = browserRevisionRef.current !== null;
        browserRevisionRef.current = null;
        browserDismissedRef.current = false;
        dismissedBrowserToolCallIdRef.current = null;
        setContext((current) => current.browser
          ? { ...current, browser: null }
          : current);
        if (browserWasActive) {
          onCloseRef.current('browser');
        }
      }, 0);
      return () => window.clearTimeout(timeout);
    }

    browserSnapshotRef.current = snapshot;
    const activeBrowserToolCallId = runtimeStatus.activeTool?.name === 'browser'
      ? runtimeStatus.activeTool.toolCallId
      : null;
    const wasDismissed = browserDismissedRef.current;
    if (wasDismissed) {
      const isNewBrowserToolCall = Boolean(
        activeBrowserToolCallId
        && activeBrowserToolCallId !== dismissedBrowserToolCallIdRef.current,
      );
      if (!isNewBrowserToolCall) {
        return;
      }
    }
    if (scopeResetTimerRef.current !== null) {
      window.clearTimeout(scopeResetTimerRef.current);
      scopeResetTimerRef.current = null;
    }

    const status = runtimeStatus.activeTool?.name === 'browser' ? 'running' : 'complete';
    const intentRevision = browserIntentRevisionRef.current;
    const timeout = window.setTimeout(() => {
      if (intentRevision !== browserIntentRevisionRef.current) return;
      const shouldOpen = browserRevisionRef.current === null || wasDismissed;
      browserRevisionRef.current = snapshot.revision;
      browserDismissedRef.current = false;
      dismissedBrowserToolCallIdRef.current = null;
      setContext((current) => ({
        ...current,
        browser: {
          kind: 'browser',
          toolCallId: runtimeStatus.activeTool?.name === 'browser'
            ? runtimeStatus.activeTool.toolCallId
            : null,
          toolName: 'browser',
          status,
          agentId: chatContext.agentId,
          sessionId: chatContext.sessionId,
          snapshot,
          url: snapshot.activeUrl ?? undefined,
        },
      }));

      if (shouldOpen) {
        onOpenRef.current('browser');
      }
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [chatContext, runtimeStatus]);

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

      const browserSnapshot = browserSnapshotRef.current;
      const intent = notebookContextIntentFromAgentEvent(
        detail.event,
        activeChatContext,
        browserSnapshot,
      );
      if (!intent) return;
      if (
        intent.kind === 'browser'
        && browserDismissedRef.current
      ) {
        return;
      }
      if (
        intent.toolCallId
        && dismissedToolCallsRef.current.has(intent.toolCallId)
      ) {
        return;
      }
      if (scopeResetTimerRef.current !== null) {
        window.clearTimeout(scopeResetTimerRef.current);
        scopeResetTimerRef.current = null;
      }

      setContext((current) => (
        intent.kind === 'email'
          ? { ...current, email: mergeIntent(current.email, intent) }
          : { ...current, browser: mergeIntent(current.browser, intent) }
      ));
      if (detail.event.type === 'tool_execution_start' && intent.kind === 'email') {
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
    browserIntentRevisionRef.current += 1;
    browserDismissedRef.current = true;
    dismissedBrowserToolCallIdRef.current = browserActiveToolRef.current?.toolCallId ?? null;
    setContext((current) => {
      return { ...current, browser: null };
    });
  }, []);

  const openBrowser = useCallback(() => {
    const scope = chatContextRef.current;
    const snapshot = browserSnapshotRef.current;
    if (!scope || !snapshot?.running) return;
    browserIntentRevisionRef.current += 1;
    browserDismissedRef.current = false;
    dismissedBrowserToolCallIdRef.current = null;
    browserRevisionRef.current = snapshot.revision;
    const tool = browserActiveToolRef.current;
    setContext((current) => ({
      ...current,
      browser: {
        kind: 'browser',
        toolName: 'browser',
        toolCallId: tool?.toolCallId ?? null,
        status: tool ? 'running' : 'complete',
        ...scope,
        snapshot,
        url: snapshot.activeUrl ?? undefined,
      },
    }));
    onOpenRef.current('browser');
  }, []);

  return {
    emailContext: context.email,
    browserContext: context.browser?.agentId === chatContext?.agentId
      && context.browser?.sessionId === chatContext?.sessionId ? context.browser : null,
    clearEmail,
    clearBrowser,
    openBrowser,
  };
}
