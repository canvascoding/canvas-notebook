'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/app/lib/chat/types';

const BOTTOM_LOCK_THRESHOLD_PX = 12;
const SCROLL_BUTTON_THRESHOLD_PX = 160;
const TOUCH_SCROLL_UNLOCK_THRESHOLD_PX = 8;

export function useChatScrollController({ messages }: { messages: ChatMessage[] }) {
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const previousMessageCountRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const autoScrollRef = useRef<{ top: number; time: number } | null>(null);
  const autoScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchScrollStartYRef = useRef<number | null>(null);
  const resizeObserverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markAutoScroll = useCallback((container: HTMLElement) => {
    autoScrollRef.current = {
      top: Math.max(0, container.scrollHeight - container.clientHeight),
      time: Date.now(),
    };

    if (autoScrollTimerRef.current) {
      clearTimeout(autoScrollTimerRef.current);
    }

    autoScrollTimerRef.current = setTimeout(() => {
      autoScrollRef.current = null;
      autoScrollTimerRef.current = null;
    }, 1500);
  }, []);

  const isProgrammaticScroll = useCallback((container: HTMLElement) => {
    const marker = autoScrollRef.current;
    if (!marker) {
      return false;
    }

    if (Date.now() - marker.time > 1500) {
      autoScrollRef.current = null;
      return false;
    }

    return Math.abs(container.scrollTop - marker.top) < 2;
  }, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    markAutoScroll(container);
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    setShowScrollButton(false);
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior });
    }
  }, [markAutoScroll]);

  const releaseBottomLock = useCallback(() => {
    if (!isAtBottomRef.current) {
      return;
    }

    isAtBottomRef.current = false;
    setIsAtBottom(false);
  }, []);

  const syncBottomLockState = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) {
      return true;
    }

    const distanceFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
    const nextIsAtBottom = distanceFromBottom <= BOTTOM_LOCK_THRESHOLD_PX;
    const nextShowScrollButton = distanceFromBottom > SCROLL_BUTTON_THRESHOLD_PX;
    isAtBottomRef.current = nextIsAtBottom;
    setIsAtBottom((current) => {
      if (current === nextIsAtBottom) return current;
      return nextIsAtBottom;
    });
    setShowScrollButton((current) => {
      if (current === nextShowScrollButton) return current;
      return nextShowScrollButton;
    });
    return nextIsAtBottom;
  }, []);

  const handleScroll = useCallback(() => {
    const scrollContainer = scrollContainerRef.current;
    if (scrollContainer && isAtBottomRef.current && isProgrammaticScroll(scrollContainer)) {
      scrollToBottom('auto');
      return;
    }

    syncBottomLockState();
  }, [isProgrammaticScroll, scrollToBottom, syncBottomLockState]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) {
      releaseBottomLock();
    }
  }, [releaseBottomLock]);

  const handleTouchStart = useCallback((event: TouchEvent) => {
    touchScrollStartYRef.current = event.touches[0]?.clientY ?? null;
  }, []);

  const handleTouchMove = useCallback((event: TouchEvent) => {
    const startY = touchScrollStartYRef.current;
    const currentY = event.touches[0]?.clientY;
    if (startY == null || currentY == null) {
      return;
    }

    if (currentY - startY > TOUCH_SCROLL_UNLOCK_THRESHOLD_PX) {
      releaseBottomLock();
    }
  }, [releaseBottomLock]);

  const handleTouchEnd = useCallback(() => {
    touchScrollStartYRef.current = null;
  }, []);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    if (!scrollContainer) return;
    syncBottomLockState();
    scrollContainer.addEventListener('scroll', handleScroll);
    scrollContainer.addEventListener('wheel', handleWheel, { passive: true });
    scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollContainer.addEventListener('touchend', handleTouchEnd);
    scrollContainer.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      scrollContainer.removeEventListener('wheel', handleWheel);
      scrollContainer.removeEventListener('touchstart', handleTouchStart);
      scrollContainer.removeEventListener('touchmove', handleTouchMove);
      scrollContainer.removeEventListener('touchend', handleTouchEnd);
      scrollContainer.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleScroll, handleTouchEnd, handleTouchMove, handleTouchStart, handleWheel, syncBottomLockState]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollContainer || !scrollContent) return;

    const resizeObserver = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;

      if (resizeObserverTimerRef.current) {
        clearTimeout(resizeObserverTimerRef.current);
      }

      resizeObserverTimerRef.current = setTimeout(() => {
        resizeObserverTimerRef.current = null;
        scrollToBottom('auto');
      }, 200);
    });

    resizeObserver.observe(scrollContent);
    return () => {
      resizeObserver.disconnect();
      if (resizeObserverTimerRef.current) {
        clearTimeout(resizeObserverTimerRef.current);
        resizeObserverTimerRef.current = null;
      }
    };
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    if (messages.length === 0) {
      previousMessageCountRef.current = 0;
      isAtBottomRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsAtBottom(true);
      setShowScrollButton(false);
      return;
    }

    const messageCountIncreased = messages.length > previousMessageCountRef.current;

    if (!messageCountIncreased) {
      previousMessageCountRef.current = messages.length;
      return;
    }

    const lastMessage = messages[messages.length - 1];

    if (isAtBottomRef.current || lastMessage.role === 'user') {
      scrollToBottom(lastMessage.role === 'user' ? 'smooth' : 'auto');
    }

    previousMessageCountRef.current = messages.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run on count change, not on every message mutation
  }, [messages.length, scrollToBottom]);

  useEffect(() => () => {
    if (autoScrollTimerRef.current) {
      clearTimeout(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  return {
    isAtBottom,
    isAtBottomRef,
    messagesEndRef,
    scrollContainerRef,
    scrollContentRef,
    scrollToBottom,
    showScrollButton,
  };
}
