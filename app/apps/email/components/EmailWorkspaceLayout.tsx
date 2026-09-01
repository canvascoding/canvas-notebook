'use client';

import { useCallback, useEffect, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefCallback } from 'react';

import { cn } from '@/lib/utils';

export type EmailWorkspaceLayoutMode = 'wide' | 'compact' | 'mobile';

const LIST_WIDTH_STORAGE_KEY = 'canvas:email:message-list-width:v1';
const MIN_LIST_WIDTH = 280;
const MAX_LIST_WIDTH = 560;
const DEFAULT_LIST_WIDTH = 380;

function clampListWidth(value: number) {
  return Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(value)));
}

function modeForWidth(width: number): EmailWorkspaceLayoutMode {
  if (width < 600) return 'mobile';
  if (width < 960) return 'compact';
  return 'wide';
}

function readStoredListWidth() {
  try {
    const stored = Number(window.localStorage.getItem(LIST_WIDTH_STORAGE_KEY));
    return Number.isFinite(stored) ? clampListWidth(stored) : DEFAULT_LIST_WIDTH;
  } catch {
    return DEFAULT_LIST_WIDTH;
  }
}

export function useEmailWorkspaceLayout(): {
  containerRef: RefCallback<HTMLDivElement>;
  listWidth: number;
  mode: EmailWorkspaceLayoutMode;
  setListWidth(value: number): void;
} {
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback<RefCallback<HTMLDivElement>>((element) => {
    setContainerElement(element);
  }, []);
  const [mode, setMode] = useState<EmailWorkspaceLayoutMode>('compact');
  const [listWidth, setListWidthState] = useState(DEFAULT_LIST_WIDTH);

  useEffect(() => {
    const timeout = window.setTimeout(() => setListWidthState(readStoredListWidth()), 0);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    if (!containerElement) return;
    const update = () => setMode(modeForWidth(containerElement.getBoundingClientRect().width));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(containerElement);
    return () => observer.disconnect();
  }, [containerElement]);

  const setListWidth = useCallback((value: number) => {
    const next = clampListWidth(value);
    setListWidthState(next);
    try {
      window.localStorage.setItem(LIST_WIDTH_STORAGE_KEY, String(next));
    } catch {
      // Resizing remains available when storage is unavailable.
    }
  }, []);

  return { containerRef, listWidth, mode, setListWidth };
}

export function EmailPaneResizeHandle({
  className,
  label,
  onWidthChange,
  width,
}: {
  className?: string;
  label: string;
  onWidthChange(value: number): void;
  width: number;
}) {
  const resizeFromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (moveEvent: PointerEvent) => onWidthChange(startWidth + moveEvent.clientX - startX);
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp, { once: true });
  };
  const resizeFromKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    onWidthChange(width + (event.key === 'ArrowRight' ? 24 : -24));
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={MAX_LIST_WIDTH}
      aria-valuemin={MIN_LIST_WIDTH}
      aria-valuenow={width}
      className={cn('group relative w-2 cursor-col-resize touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
      onKeyDown={resizeFromKeyboard}
      onPointerDown={resizeFromPointer}
    >
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
    </div>
  );
}
