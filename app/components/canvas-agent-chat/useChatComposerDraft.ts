'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import { contentToString } from '@/app/lib/chat/message-content';
import { removeComposerDraft, saveComposerDraft } from '@/app/lib/chat/draft-storage';
import type { ChatMessage } from '@/app/lib/chat/types';

type UseChatComposerDraftParams = {
  input: string;
  messages: ChatMessage[];
  sessionIdRef: RefObject<string | null>;
  setInput: Dispatch<SetStateAction<string>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function useChatComposerDraft({
  input,
  messages,
  sessionIdRef,
  setInput,
  textareaRef,
}: UseChatComposerDraftParams) {
  const inputHistoryCursorRef = useRef<number | null>(null);
  const inputHistoryDraftRef = useRef('');
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const userMessageHistory = useMemo(() => (
    messages
      .filter((message) => message.role === 'user')
      .map((message) => contentToString(message.content).trim())
      .filter(Boolean)
  ), [messages]);

  const resetInputHistoryNavigation = useCallback(() => {
    inputHistoryCursorRef.current = null;
    inputHistoryDraftRef.current = '';
  }, []);

  const applyInputHistoryValue = useCallback((value: string) => {
    setInput(value);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(value.length, value.length);
    });
  }, [setInput, textareaRef]);

  const navigateInputHistory = useCallback((direction: 'older' | 'newer'): boolean => {
    if (userMessageHistory.length === 0) {
      return false;
    }

    const currentCursor = inputHistoryCursorRef.current;
    let nextCursor: number | null;

    if (direction === 'older') {
      if (currentCursor === null) {
        inputHistoryDraftRef.current = input;
        nextCursor = userMessageHistory.length - 1;
      } else {
        nextCursor = Math.max(0, currentCursor - 1);
      }
    } else {
      if (currentCursor === null) {
        return false;
      }
      nextCursor = currentCursor >= userMessageHistory.length - 1 ? null : currentCursor + 1;
    }

    inputHistoryCursorRef.current = nextCursor;
    applyInputHistoryValue(nextCursor === null ? inputHistoryDraftRef.current : userMessageHistory[nextCursor]);
    return true;
  }, [applyInputHistoryValue, input, userMessageHistory]);

  useEffect(() => {
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
    }
    draftSaveTimerRef.current = setTimeout(() => {
      const key = sessionIdRef.current ?? '__new__';
      if (input.trim()) {
        saveComposerDraft(key, input);
      } else {
        removeComposerDraft(key);
      }
    }, 300);
  }, [input, sessionIdRef]);

  return {
    navigateInputHistory,
    resetInputHistoryNavigation,
  };
}
