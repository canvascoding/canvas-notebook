'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { ChatMessage } from '@/app/lib/chat/types';
import {
  captureChatScrollAnchor,
  restoreChatScrollAnchor,
  type ChatScrollAnchor,
} from '@/app/lib/chat/scroll-anchor';

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
  const programmaticScrollUntilRef = useRef(0);
  const bottomSyncFrameRef = useRef<number | null>(null);
  const anchorCaptureFrameRef = useRef<number | null>(null);
  const scrollAnchorRef = useRef<ChatScrollAnchor | null>(null);
  const touchScrollStartYRef = useRef<number | null>(null);

  const markAutoScroll = useCallback((behavior: ScrollBehavior) => {
    programmaticScrollUntilRef.current = Date.now() + (behavior === 'smooth' ? 1500 : 100);
  }, []);

  const isProgrammaticScroll = useCallback(() => {
    return Date.now() <= programmaticScrollUntilRef.current;
  }, []);

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const content = scrollContentRef.current;
    if (!container || !content || isAtBottomRef.current) {
      scrollAnchorRef.current = null;
      return;
    }
    scrollAnchorRef.current = captureChatScrollAnchor(container, content);
  }, []);

  const scheduleAnchorCapture = useCallback(() => {
    if (anchorCaptureFrameRef.current !== null) return;
    anchorCaptureFrameRef.current = requestAnimationFrame(() => {
      anchorCaptureFrameRef.current = null;
      captureAnchor();
    });
  }, [captureAnchor]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = scrollContainerRef.current;
    if (!container) return;
    markAutoScroll(behavior);
    isAtBottomRef.current = true;
    scrollAnchorRef.current = null;
    setIsAtBottom(true);
    setShowScrollButton(false);
    if (behavior === 'auto') {
      container.scrollTop = container.scrollHeight - container.clientHeight;
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior });
    }
  }, [markAutoScroll]);

  const scheduleBottomSync = useCallback(() => {
    if (bottomSyncFrameRef.current !== null) return;
    bottomSyncFrameRef.current = requestAnimationFrame(() => {
      bottomSyncFrameRef.current = null;
      if (isAtBottomRef.current) scrollToBottom('auto');
    });
  }, [scrollToBottom]);

  const cancelAutoScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTo({ top: container.scrollTop, behavior: 'auto' });
    }
    programmaticScrollUntilRef.current = 0;
    if (bottomSyncFrameRef.current !== null) {
      cancelAnimationFrame(bottomSyncFrameRef.current);
      bottomSyncFrameRef.current = null;
    }
  }, []);

  const releaseBottomLock = useCallback(() => {
    cancelAutoScroll();
    if (!isAtBottomRef.current) {
      return;
    }

    isAtBottomRef.current = false;
    setIsAtBottom(false);
    scheduleAnchorCapture();
  }, [cancelAutoScroll, scheduleAnchorCapture]);

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
    if (scrollContainer && isAtBottomRef.current && isProgrammaticScroll()) {
      return;
    }

    const atBottom = syncBottomLockState();
    if (atBottom) scrollAnchorRef.current = null;
    else scheduleAnchorCapture();
  }, [isProgrammaticScroll, scheduleAnchorCapture, syncBottomLockState]);

  const handleWheel = useCallback((event: WheelEvent) => {
    if (event.deltaY < 0) {
      releaseBottomLock();
    }
  }, [releaseBottomLock]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home'
      || (event.key === ' ' && event.shiftKey)) {
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
    scrollContainer.addEventListener('keydown', handleKeyDown);
    scrollContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
    scrollContainer.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollContainer.addEventListener('touchend', handleTouchEnd);
    scrollContainer.addEventListener('touchcancel', handleTouchEnd);
    return () => {
      scrollContainer.removeEventListener('scroll', handleScroll);
      scrollContainer.removeEventListener('wheel', handleWheel);
      scrollContainer.removeEventListener('keydown', handleKeyDown);
      scrollContainer.removeEventListener('touchstart', handleTouchStart);
      scrollContainer.removeEventListener('touchmove', handleTouchMove);
      scrollContainer.removeEventListener('touchend', handleTouchEnd);
      scrollContainer.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleKeyDown, handleScroll, handleTouchEnd, handleTouchMove, handleTouchStart, handleWheel, syncBottomLockState]);

  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const scrollContent = scrollContentRef.current;
    if (!scrollContainer || !scrollContent) return;

    captureAnchor();
    const resizeObserver = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        scheduleBottomSync();
        return;
      }

      restoreChatScrollAnchor(scrollContainer, scrollContent, scrollAnchorRef.current);
      scheduleAnchorCapture();
    });

    resizeObserver.observe(scrollContent);
    resizeObserver.observe(scrollContainer);
    return () => {
      resizeObserver.disconnect();
    };
  }, [captureAnchor, scheduleAnchorCapture, scheduleBottomSync]);

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
    if (bottomSyncFrameRef.current !== null) cancelAnimationFrame(bottomSyncFrameRef.current);
    if (anchorCaptureFrameRef.current !== null) cancelAnimationFrame(anchorCaptureFrameRef.current);
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
