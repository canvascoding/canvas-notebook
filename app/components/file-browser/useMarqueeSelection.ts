'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { FileNode } from '@/app/lib/files/types';
import {
  getIntersectingMarqueePaths,
  mergeMarqueeSelection,
  normalizeMarqueeRect,
  shouldClearSelectionOnBackgroundClick,
  type MarqueePoint,
  type MarqueeRect,
} from '@/app/lib/files/marquee-selection';
import { useFileStore } from '@/app/store/file-store';

const MARQUEE_START_THRESHOLD = 4;
const AUTO_SCROLL_EDGE_SIZE = 40;
const AUTO_SCROLL_MAX_SPEED = 16;
const MARQUEE_BLOCKING_TARGETS = [
  '[data-file-path]',
  '[data-marquee-ignore]',
  'button',
  'a',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="menuitem"]',
].join(',');

export interface MarqueeOverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface InitialSelectionState {
  selectedNode: FileNode | null;
  multiSelectPaths: Set<string>;
  isMultiSelectMode: boolean;
  lastSelectedPath: string | null;
}

interface MarqueeSession {
  pointerId: number;
  startPoint: MarqueePoint;
  additive: boolean;
  basePaths: Set<string>;
  initialSelection: InitialSelectionState;
  currentPaths: Set<string>;
  lastSelectionKey: string | null;
  lastClientX: number;
  lastClientY: number;
  active: boolean;
  previousBodyUserSelect: string | null;
}

interface MarqueeContainerRef {
  current: HTMLDivElement | null;
}

function getContentPoint(
  container: HTMLDivElement,
  clientX: number,
  clientY: number,
): MarqueePoint {
  const containerRect = container.getBoundingClientRect();
  const clampedX = Math.min(Math.max(clientX, containerRect.left), containerRect.right);
  const clampedY = Math.min(Math.max(clientY, containerRect.top), containerRect.bottom);
  return {
    x: clampedX - containerRect.left + container.scrollLeft,
    y: clampedY - containerRect.top + container.scrollTop,
  };
}

function getOverlayRect(
  container: HTMLDivElement,
  selectionRect: MarqueeRect,
): MarqueeOverlayRect {
  const containerRect = container.getBoundingClientRect();
  const unclampedLeft = containerRect.left + selectionRect.left - container.scrollLeft;
  const unclampedTop = containerRect.top + selectionRect.top - container.scrollTop;
  const unclampedRight = containerRect.left + selectionRect.right - container.scrollLeft;
  const unclampedBottom = containerRect.top + selectionRect.bottom - container.scrollTop;
  const left = Math.max(containerRect.left, unclampedLeft);
  const top = Math.max(containerRect.top, unclampedTop);
  const right = Math.min(containerRect.right, unclampedRight);
  const bottom = Math.min(containerRect.bottom, unclampedBottom);

  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

function getSelectionKey(paths: Iterable<string>): string {
  return Array.from(paths).sort().join('\0');
}

function getAutoScrollSpeed(pointerPosition: number, start: number, end: number): number {
  if (pointerPosition < start + AUTO_SCROLL_EDGE_SIZE) {
    const intensity = Math.min(1, (start + AUTO_SCROLL_EDGE_SIZE - pointerPosition) / AUTO_SCROLL_EDGE_SIZE);
    return -Math.max(1, Math.ceil(intensity * AUTO_SCROLL_MAX_SPEED));
  }
  if (pointerPosition > end - AUTO_SCROLL_EDGE_SIZE) {
    const intensity = Math.min(1, (pointerPosition - (end - AUTO_SCROLL_EDGE_SIZE)) / AUTO_SCROLL_EDGE_SIZE);
    return Math.max(1, Math.ceil(intensity * AUTO_SCROLL_MAX_SPEED));
  }
  return 0;
}

export function useMarqueeSelection(containerRef: MarqueeContainerRef) {
  const [overlayRect, setOverlayRect] = useState<MarqueeOverlayRect | null>(null);
  const sessionRef = useRef<MarqueeSession | null>(null);
  const autoScrollFrameRef = useRef<number | null>(null);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
  }, []);

  const restoreBodySelection = useCallback((session: MarqueeSession) => {
    if (session.previousBodyUserSelect !== null) {
      document.body.style.userSelect = session.previousBodyUserSelect;
      session.previousBodyUserSelect = null;
    }
  }, []);

  const updateSelection = useCallback((clientX: number, clientY: number) => {
    const container = containerRef.current;
    const session = sessionRef.current;
    if (!container || !session?.active) return;

    session.lastClientX = clientX;
    session.lastClientY = clientY;
    const selectionRect = normalizeMarqueeRect(
      session.startPoint,
      getContentPoint(container, clientX, clientY),
    );
    setOverlayRect(getOverlayRect(container, selectionRect));

    const containerRect = container.getBoundingClientRect();
    const itemRects = Array.from(
      container.querySelectorAll<HTMLElement>('[data-file-path]'),
    ).flatMap((element) => {
      const path = element.dataset.filePath;
      if (!path || element.offsetParent === null) return [];
      const rect = element.getBoundingClientRect();
      return [{
        path,
        left: rect.left - containerRect.left + container.scrollLeft,
        top: rect.top - containerRect.top + container.scrollTop,
        right: rect.right - containerRect.left + container.scrollLeft,
        bottom: rect.bottom - containerRect.top + container.scrollTop,
      }];
    });
    const intersectingPaths = getIntersectingMarqueePaths(itemRects, selectionRect);
    const nextPaths = mergeMarqueeSelection(
      session.basePaths,
      intersectingPaths,
      session.additive,
    );
    const selectionKey = getSelectionKey(nextPaths);
    session.currentPaths = nextPaths;
    if (selectionKey === session.lastSelectionKey) return;

    session.lastSelectionKey = selectionKey;
    useFileStore.getState().setMultiSelectPaths(
      nextPaths,
      session.initialSelection.isMultiSelectMode,
    );
  }, [containerRef]);

  const runAutoScroll = useCallback(function runAutoScrollFrame() {
    autoScrollFrameRef.current = null;
    const container = containerRef.current;
    const session = sessionRef.current;
    if (!container || !session?.active) return;

    const rect = container.getBoundingClientRect();
    const speed = getAutoScrollSpeed(session.lastClientY, rect.top, rect.bottom);
    const previousScrollTop = container.scrollTop;
    if (speed !== 0) {
      container.scrollTop += speed;
    }
    if (container.scrollTop !== previousScrollTop) {
      updateSelection(session.lastClientX, session.lastClientY);
    }
    if (speed !== 0 && container.scrollTop !== previousScrollTop) {
      autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScrollFrame);
    }
  }, [containerRef, updateSelection]);

  const scheduleAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) return;
    autoScrollFrameRef.current = window.requestAnimationFrame(runAutoScroll);
  }, [runAutoScroll]);

  const finishSelection = useCallback((commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;

    sessionRef.current = null;
    const container = containerRef.current;
    if (container?.hasPointerCapture(session.pointerId)) {
      container.releasePointerCapture(session.pointerId);
    }
    stopAutoScroll();
    restoreBodySelection(session);
    setOverlayRect(null);

    if (commit && shouldClearSelectionOnBackgroundClick(session.active, session.additive)) {
      useFileStore.getState().clearMultiSelect();
      return;
    }
    if (!session.active) {
      return;
    }
    if (commit) {
      useFileStore.getState().setMultiSelectPaths(
        session.currentPaths,
        session.currentPaths.size > 0,
      );
      return;
    }

    useFileStore.setState({
      selectedNode: session.initialSelection.selectedNode,
      multiSelectPaths: new Set(session.initialSelection.multiSelectPaths),
      isMultiSelectMode: session.initialSelection.isMultiSelectMode,
      lastSelectedPath: session.initialSelection.lastSelectedPath,
    });
  }, [containerRef, restoreBodySelection, stopAutoScroll]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary || event.pointerType !== 'mouse') return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest(MARQUEE_BLOCKING_TARGETS)) return;

    const container = event.currentTarget;
    const rect = container.getBoundingClientRect();
    const verticalScrollbarWidth = container.offsetWidth - container.clientWidth;
    const horizontalScrollbarHeight = container.offsetHeight - container.clientHeight;
    if (
      (verticalScrollbarWidth > 0 && event.clientX >= rect.right - verticalScrollbarWidth)
      || (horizontalScrollbarHeight > 0 && event.clientY >= rect.bottom - horizontalScrollbarHeight)
    ) return;

    const state = useFileStore.getState();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const basePaths = new Set(state.multiSelectPaths);
    if (state.selectedNode) basePaths.add(state.selectedNode.path);
    const initialSelection: InitialSelectionState = {
      selectedNode: state.selectedNode,
      multiSelectPaths: new Set(state.multiSelectPaths),
      isMultiSelectMode: state.isMultiSelectMode,
      lastSelectedPath: state.lastSelectedPath,
    };
    const startPoint = getContentPoint(container, event.clientX, event.clientY);
    const currentPaths = additive ? new Set(basePaths) : new Set<string>();

    sessionRef.current = {
      pointerId: event.pointerId,
      startPoint,
      additive,
      basePaths,
      initialSelection,
      currentPaths,
      lastSelectionKey: null,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      active: false,
      previousBodyUserSelect: null,
    };
    container.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;

    session.lastClientX = event.clientX;
    session.lastClientY = event.clientY;
    if (!session.active) {
      const container = containerRef.current;
      if (!container) return;
      const currentPoint = getContentPoint(container, event.clientX, event.clientY);
      const distanceX = currentPoint.x - session.startPoint.x;
      const distanceY = currentPoint.y - session.startPoint.y;
      if (Math.hypot(distanceX, distanceY) < MARQUEE_START_THRESHOLD) return;

      session.active = true;
      session.previousBodyUserSelect = document.body.style.userSelect;
      document.body.style.userSelect = 'none';
      useFileStore.getState().closeContextMenu();
      useFileStore.getState().closeBackgroundContextMenu();
    }

    event.preventDefault();
    updateSelection(event.clientX, event.clientY);
    scheduleAutoScroll();
  }, [containerRef, scheduleAutoScroll, updateSelection]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (session.active) {
      event.preventDefault();
      updateSelection(event.clientX, event.clientY);
    }
    finishSelection(true);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, [finishSelection, updateSelection]);

  const handlePointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sessionRef.current?.pointerId !== event.pointerId) return;
    finishSelection(false);
  }, [finishSelection]);

  const handleLostPointerCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (sessionRef.current?.pointerId !== event.pointerId) return;
    finishSelection(false);
  }, [finishSelection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !sessionRef.current?.active) return;
      event.preventDefault();
      finishSelection(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      finishSelection(false);
    };
  }, [finishSelection]);

  return {
    marqueeHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerCancel,
      onLostPointerCapture: handleLostPointerCapture,
    },
    marqueeOverlayRect: overlayRect,
  };
}
