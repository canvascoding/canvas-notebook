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
import { composerDraftScope, removeComposerDraftIfUnchanged, saveComposerDraft, type ComposerDraftEntry } from '@/app/lib/chat/draft-storage';
import type { ChatMessage } from '@/app/lib/chat/types';
import { parseChatBody, projectChatBodyText, type ChatBodyV1 } from '@/app/lib/chat/chat-body-contracts';
import type { ChatInlineEditorHandle } from './ChatInlineEditor';

type UseChatComposerDraftParams = {
  input: string;
  inputBody?: ChatBodyV1;
  messages: ChatMessage[];
  sessionId: string | null;
  setInput: Dispatch<SetStateAction<string>>;
  setInputBody?: Dispatch<SetStateAction<ChatBodyV1>>;
  editorRef?: RefObject<ChatInlineEditorHandle | null>;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
};

export function useChatComposerDraft({
  input,
  inputBody,
  messages,
  sessionId,
  setInput,
  setInputBody,
  editorRef,
  textareaRef,
}: UseChatComposerDraftParams) {
  const inputHistoryCursorRef = useRef<number | null>(null);
  const inputHistoryDraftRef = useRef<{ text: string; body?: ChatBodyV1 }>({ text: '' });
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observedDraftsRef = useRef(new Map<string, Pick<ComposerDraftEntry, 'text' | 'body'>>());
  const savedDraftsRef = useRef(new Map<string, Pick<ComposerDraftEntry, 'text' | 'body'>>());

  const userMessageHistory = useMemo(() => (
    messages
      .filter((message) => message.role === 'user')
      .flatMap((message): { text: string; body?: ChatBodyV1 }[] => {
        const originalBody = (message as ChatMessage & { body?: ChatBodyV1 }).body
          ?? (message.piMessage as { body?: ChatBodyV1 } | undefined)?.body;
        if (originalBody !== undefined) {
          try { const body = parseChatBody(originalBody); return [{ text: projectChatBodyText(body), body }]; }
          catch { return []; }
        }
        const text = contentToString(message.content).trim();
        return text ? [{ text }] : [];
      })
  ), [messages]);

  const resetInputHistoryNavigation = useCallback(() => {
    inputHistoryCursorRef.current = null;
    inputHistoryDraftRef.current = { text: '' };
  }, []);

  const applyInputHistoryValue = useCallback((value: { text: string; body?: ChatBodyV1 }) => {
    if (value.body && setInputBody) setInputBody(value.body);
    else setInput(value.text);
    requestAnimationFrame(() => {
      if (editorRef?.current) { editorRef.current.focusEnd(); return; }
      const textarea = textareaRef?.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(value.text.length, value.text.length);
    });
  }, [editorRef, setInput, setInputBody, textareaRef]);

  const navigateInputHistory = useCallback((direction: 'older' | 'newer'): boolean => {
    if (userMessageHistory.length === 0) {
      return false;
    }

    const currentCursor = inputHistoryCursorRef.current;
    let nextCursor: number | null;

    if (direction === 'older') {
      if (currentCursor === null) {
        inputHistoryDraftRef.current = { text: input, ...(inputBody === undefined ? {} : { body: parseChatBody(inputBody) }) };
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
  }, [applyInputHistoryValue, input, inputBody, userMessageHistory]);

  useEffect(() => {
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, []);

  const draftScope = composerDraftScope();
  const draftKey = sessionId ?? '__new__';
  useEffect(() => {
    if (draftSaveTimerRef.current) {
      clearTimeout(draftSaveTimerRef.current);
    }
    const body = inputBody === undefined ? undefined : parseChatBody(inputBody);
    const identity = JSON.stringify([draftScope, draftKey]);
    const value = { text: input, ...(body === undefined ? {} : { body }) };
    if (input.trim()) observedDraftsRef.current.set(identity, value);
    const observed = observedDraftsRef.current.get(identity), saved = savedDraftsRef.current.get(identity);
    draftSaveTimerRef.current = setTimeout(() => {
      if (input.trim()) {
        saveComposerDraft(draftKey, input, draftScope, body);
        savedDraftsRef.current.set(identity, value);
      } else {
        if (observed) removeComposerDraftIfUnchanged(draftKey, observed, draftScope);
        if (saved) removeComposerDraftIfUnchanged(draftKey, saved, draftScope);
        observedDraftsRef.current.delete(identity); savedDraftsRef.current.delete(identity);
      }
    }, 300);
    return () => {
      if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    };
  }, [draftKey, draftScope, input, inputBody]);

  return {
    navigateInputHistory,
    resetInputHistoryNavigation,
  };
}
