'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { ResizeHandle, usePanelResize } from '@/app/components/layout/ResizeHandle';

interface AppLayoutProps {
  sidebar: ReactNode;
  main: ReactNode;
  terminal: ReactNode;
  sidebarHidden?: boolean;
  terminalVisible?: boolean;
  terminalHidden?: boolean;
  sidebarResizeLabel?: string;
  terminalResizeLabel?: string;
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
  terminalVisible = true,
  terminalHidden = false,
  sidebarResizeLabel = 'Resize sidebar',
  terminalResizeLabel = 'Resize terminal',
}: AppLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState(288);
  const [terminalHeight, setTerminalHeight] = useState(260);
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sidebarPanelRef = useRef<HTMLDivElement | null>(null);
  const terminalPanelRef = useRef<HTMLDivElement | null>(null);
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

  const applySidebarWidth = useCallback((nextWidth: number) => {
    sidebarPanelRef.current?.style.setProperty('width', `${nextWidth}px`);
  }, []);

  const applyTerminalHeight = useCallback((nextHeight: number) => {
    terminalPanelRef.current?.style.setProperty('height', `${nextHeight}px`);
  }, []);

  const getTerminalMaxHeight = useCallback(() => {
    const containerHeight = containerRef.current?.getBoundingClientRect().height ?? window.innerHeight;
    return Math.min(TERMINAL_MAX, Math.max(TERMINAL_MIN, containerHeight - 120));
  }, []);

  const sidebarResize = usePanelResize({
    orientation: 'vertical',
    value: sidebarWidth,
    min: SIDEBAR_MIN,
    max: SIDEBAR_MAX,
    onResize: applySidebarWidth,
    onResizeEnd: setSidebarWidth,
  });

  const terminalResize = usePanelResize({
    orientation: 'horizontal',
    direction: -1,
    value: terminalHeight,
    min: TERMINAL_COLLAPSED,
    max: getTerminalMaxHeight,
    onResize: applyTerminalHeight,
    onResizeEnd: setTerminalHeight,
  });

  useEffect(() => {
    applySidebarWidth(sidebarWidth);
  }, [applySidebarWidth, sidebarWidth]);

  useEffect(() => {
    applyTerminalHeight(terminalHeight);
  }, [applyTerminalHeight, terminalHeight]);

  useEffect(() => {
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

    window.addEventListener('terminal-resize', handleResizeEvent as EventListener);

    return () => {
      window.removeEventListener('terminal-resize', handleResizeEvent as EventListener);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1">
        <div
          ref={sidebarPanelRef}
          id="app-layout-sidebar"
          style={{ width: sidebarWidth }}
          className={terminalFullscreen || sidebarHidden ? 'hidden' : 'shrink-0 min-h-0'}
        >
          {sidebar}
        </div>
        {terminalFullscreen || sidebarHidden ? null : (
          <ResizeHandle
            orientation="vertical"
            label={sidebarResizeLabel}
            controls="app-layout-sidebar"
            min={SIDEBAR_MIN}
            max={SIDEBAR_MAX}
            value={sidebarWidth}
            resizing={sidebarResize.isResizing}
            {...sidebarResize.handleProps}
          />
        )}
        <div className={terminalFullscreen ? 'hidden' : 'min-w-0 flex-1'}>{main}</div>
      </div>
      
      {terminalVisible && (
        <div
          hidden={terminalHidden}
          className={
            terminalFullscreen
              ? 'fixed inset-0 z-[100] bg-background overflow-hidden overscroll-contain'
              : 'relative z-30 bg-background flex-shrink-0'
          }
        >
          {!terminalFullscreen && (
            <ResizeHandle
              data-testid="terminal-resize-handle"
              orientation="horizontal"
              label={terminalResizeLabel}
              controls="app-layout-terminal"
              min={TERMINAL_COLLAPSED}
              max={TERMINAL_MAX}
              value={terminalHeight}
              resizing={terminalResize.isResizing}
              {...terminalResize.handleProps}
            />
          )}
          <div
            ref={terminalPanelRef}
            id="app-layout-terminal"
            style={{ height: terminalHeight }}
            className="min-h-0"
          >
            {terminal}
          </div>
        </div>
      )}
    </div>
  );
}
