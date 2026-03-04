'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

interface AppLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  terminal: ReactNode;
  sidebarHidden?: boolean;
  terminalVisible?: boolean;
}

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 420;
const TERMINAL_MIN = 160;
const TERMINAL_MAX = 420;
const TERMINAL_COLLAPSED = 84;

export function AppLayout({ 
  sidebar, 
  main, 
  terminal, 
  sidebarHidden = false,
  terminalVisible = true 
}: AppLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    type: 'sidebar' | 'terminal' | null;
    pointerId: number | null;
    startX: number;
    startY: number;
    startWidth: number;
    startHeight: number;
  } | null>(null);
  const lastTerminalHeightRef = useRef<number>(terminalHeight);

  // This effect runs only once on the client to safely read from localStorage
  useEffect(() => {
    const storedSidebarWidth = window.localStorage.getItem('canvas.sidebarWidth');
    if (storedSidebarWidth) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSidebarWidth(Number(storedSidebarWidth));
    }
    const storedTerminalHeight = window.localStorage.getItem('canvas.terminalHeight');
    if (storedTerminalHeight) {
      const value = Number(storedTerminalHeight);
      setTerminalHeight(value < TERMINAL_MIN ? 260 : value);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem('canvas.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem('canvas.terminalHeight', String(terminalHeight));
    if (terminalHeight > TERMINAL_COLLAPSED) {
      lastTerminalHeightRef.current = terminalHeight;
    }
  }, [terminalHeight]);

  // Reset fullscreen when terminal is hidden
  useEffect(() => {
    if (!terminalVisible) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTerminalFullscreen(false);
    }
  }, [terminalVisible]);

  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent('terminal-fullscreen-state', {
        detail: { enabled: terminalFullscreen },
      })
    );
  }, [terminalFullscreen]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const body = document.body;
    const html = document.documentElement;
    if (terminalFullscreen) {
      body.style.overflow = 'hidden';
      html.style.overflow = 'hidden';
    } else {
      body.style.overflow = '';
      html.style.overflow = '';
    }

    return () => {
      body.style.overflow = '';
      html.style.overflow = '';
    };
  }, [terminalFullscreen]);

  useEffect(() => {
    if (!terminalFullscreen) return;
    const updateHeight = () => {
      setTerminalHeight(window.innerHeight);
    };
    updateHeight();
    window.addEventListener('resize', updateHeight);
    return () => window.removeEventListener('resize', updateHeight);
  }, [terminalFullscreen]);

  useEffect(() => {
    const handleMove = (event: MouseEvent | PointerEvent) => {
      if (!dragRef.current || !containerRef.current) return;
      if (terminalFullscreen && dragRef.current.type === 'terminal') return;
      if ('pointerId' in event && dragRef.current.pointerId !== null && event.pointerId !== dragRef.current.pointerId) {
        return;
      }
      const { type, startX, startY, startWidth, startHeight } = dragRef.current;

      if (type === 'sidebar') {
        const nextWidth = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startWidth + (event.clientX - startX))
        );
        setSidebarWidth(nextWidth);
      }

      if (type === 'terminal') {
        const containerRect = containerRef.current.getBoundingClientRect();
        const delta = event.clientY - startY;
        const nextHeight = Math.min(
          TERMINAL_MAX,
          Math.max(TERMINAL_MIN, startHeight - delta)
        );
        const maxAllowed = containerRect.height - 120;
        setTerminalHeight(Math.min(nextHeight, maxAllowed));
      }
    };

    const handleUp = (event?: PointerEvent | Event) => {
      if (event instanceof PointerEvent) {
        const pointerId = dragRef.current?.pointerId;
        if (pointerId !== null && pointerId !== undefined && event.pointerId !== pointerId) {
          return;
        }
      }
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    const handleResizeEvent = (event: Event) => {
      if (!(event instanceof CustomEvent) || !containerRef.current) return;
      const detail = event.detail as { action?: string; height?: number } | undefined;
      const action = detail?.action;
      const containerRect = containerRef.current.getBoundingClientRect();
      const maxAllowed = Math.min(TERMINAL_MAX, containerRect.height - 120);

      if (action === 'minimize') {
        setTerminalHeight(TERMINAL_COLLAPSED);
        return;
      }

      if (action === 'maximize') {
        setTerminalHeight(maxAllowed);
        return;
      }

      if (action === 'restore') {
        const restored = Math.min(
          maxAllowed,
          Math.max(TERMINAL_MIN, lastTerminalHeightRef.current || TERMINAL_MIN)
        );
        setTerminalHeight(restored);
        return;
      }

      if (action === 'set' && Number.isFinite(detail?.height)) {
        const next = Math.min(
          maxAllowed,
          Math.max(TERMINAL_MIN, detail?.height || TERMINAL_MIN)
        );
        setTerminalHeight(next);
        setTerminalFullscreen(false);
        return;
      }

      if (action === 'fullscreen') {
        setTerminalFullscreen((prev) => {
          const next = !prev;
          if (next) {
            setTerminalHeight(window.innerHeight);
          } else {
            const restored = Math.min(
              maxAllowed,
              Math.max(TERMINAL_MIN, lastTerminalHeightRef.current || TERMINAL_MIN)
            );
            setTerminalHeight(restored);
          }
          return next;
        });
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    window.addEventListener('blur', handleUp);
    window.addEventListener('terminal-resize', handleResizeEvent as EventListener);

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      window.removeEventListener('blur', handleUp);
      window.removeEventListener('terminal-resize', handleResizeEvent as EventListener);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [terminalFullscreen]);

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div
          style={{ width: sidebarWidth }}
          className={terminalFullscreen || sidebarHidden ? 'hidden' : 'shrink-0 min-h-0'}
        >
          {sidebar}
        </div>
        <div
          className={
            terminalFullscreen || sidebarHidden
              ? 'hidden'
              : 'w-1 cursor-col-resize bg-border/70 hover:bg-border touch-none'
          }
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            document.body.style.userSelect = 'none';
            document.body.style.cursor = 'col-resize';
            dragRef.current = {
              type: 'sidebar',
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              startWidth: sidebarWidth,
              startHeight: terminalHeight,
            };
          }}
        />
        <div className={terminalFullscreen ? 'hidden' : 'min-w-0 flex-1'}>{main}</div>
      </div>
      
      {terminalVisible && (
        <div
          className={
            terminalFullscreen
              ? 'fixed inset-0 z-[100] bg-background overflow-hidden overscroll-contain'
              : 'relative z-30 bg-background flex-shrink-0'
          }
        >
          {!terminalFullscreen && (
            <div
              className="h-2 cursor-row-resize bg-border/70 hover:bg-border touch-none"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                document.body.style.userSelect = 'none';
                document.body.style.cursor = 'row-resize';
                dragRef.current = {
                  type: 'terminal',
                  pointerId: event.pointerId,
                  startX: event.clientX,
                  startY: event.clientY,
                  startWidth: sidebarWidth,
                  startHeight: terminalHeight,
                };
              }}
            />
          )}
          <div style={{ height: terminalHeight }} className="min-h-0">
            {terminal}
          </div>
        </div>
      )}
    </div>
  );
}
