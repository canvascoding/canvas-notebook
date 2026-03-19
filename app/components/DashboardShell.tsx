"use client";

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, PanelLeft, MessageSquare, Terminal as TerminalIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SidebarProvider } from '@/components/ui/sidebar';
import { LogoutButton } from '@/app/components/LogoutButton';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { AppLayout } from '@/app/components/layout/AppLayout';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { useFileStore } from '@/app/store/file-store';

interface DashboardShellProps {
  username: string;
}

type MobileSurface = 'files' | 'editor' | 'chat' | 'terminal';

const LEFT_SIDEBAR_MIN = 220;
const MIN_EDITOR_WIDTH = 360;

function getSidebarMaxWidth() {
  if (typeof window === 'undefined') {
    return LEFT_SIDEBAR_MIN;
  }

  return Math.max(LEFT_SIDEBAR_MIN, window.innerWidth - MIN_EDITOR_WIDTH);
}

function clampSidebarWidth(width: number) {
  return Math.min(getSidebarMaxWidth(), Math.max(LEFT_SIDEBAR_MIN, width));
}

export function DashboardShell({ username }: DashboardShellProps) {
  const searchParams = useSearchParams();
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [chatVisible, setChatVisible] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('files');
  const isResizing = useRef(false);
  const isSidebarResizing = useRef(false);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const openedPathRef = useRef<string | null>(null);

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem('canvas.leftSidebarWidth'));
    if (!Number.isFinite(storedWidth)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarWidth(clampSidebarWidth(storedWidth));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('canvas.leftSidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    const targetPath = searchParams.get('path');
    if (!targetPath || openedPathRef.current === targetPath) {
      return;
    }

    openedPathRef.current = targetPath;
    const { loadFile, setCurrentDirectory } = useFileStore.getState();
    const trimmed = targetPath.replace(/\/+$/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    const parentDir = lastSlash > 0 ? trimmed.slice(0, lastSlash) : '.';
    setCurrentDirectory(parentDir || '.');
    void loadFile(targetPath, true);
    window.dispatchEvent(
      new CustomEvent('notebook-mobile-surface', {
        detail: { surface: 'editor' satisfies MobileSurface },
      })
    );
  }, [searchParams]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - e.clientX;
    if (newWidth > 300 && newWidth < 800) {
      setChatWidth(newWidth);
    }
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  const handleSidebarMouseMove = useCallback((e: MouseEvent) => {
    if (!isSidebarResizing.current || !sidebarResizeRef.current) return;
    const nextWidth = clampSidebarWidth(
      sidebarResizeRef.current.startWidth + (e.clientX - sidebarResizeRef.current.startX)
    );
    setSidebarWidth(nextWidth);
  }, []);

  const stopSidebarResizing = useCallback(() => {
    isSidebarResizing.current = false;
    sidebarResizeRef.current = null;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  useEffect(() => {
    const handleViewport = () => {
      const isMobile = window.innerWidth < 768;
      setViewportMode(isMobile ? 'mobile' : 'desktop');
      setSidebarWidth((prev) => clampSidebarWidth(prev));
      if (isMobile) {
        setSidebarVisible(false);
        setChatVisible(false);
        setTerminalVisible(false);
      } else {
        setSidebarVisible(true);
      }
    };

    handleViewport();
    window.addEventListener('resize', handleViewport);
    return () => window.removeEventListener('resize', handleViewport);
  }, []);

  useEffect(() => {
    const handleNotebookSurface = (event: Event) => {
      if (!(event instanceof CustomEvent)) {
        return;
      }
      const nextSurface = event.detail?.surface;
      if (viewportMode === 'mobile' && typeof nextSurface === 'string') {
        setMobileSurface(nextSurface as MobileSurface);
      }
    };

    window.addEventListener('notebook-mobile-surface', handleNotebookSurface as EventListener);
    return () => {
      window.removeEventListener('notebook-mobile-surface', handleNotebookSurface as EventListener);
    };
  }, [viewportMode]);

  useEffect(() => {
    const handleMouseUp = () => {
      if (isResizing.current) {
        stopResizing();
      }
      if (isSidebarResizing.current) {
        stopSidebarResizing();
      }
    };

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (isResizing.current) {
        handleMouseMove(e);
      }
      if (isSidebarResizing.current) {
        handleSidebarMouseMove(e);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleSidebarMouseMove, stopResizing, stopSidebarResizing]);

  const startResizing = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const showMobileChrome = viewportMode !== 'desktop';
  const isMobileViewport = viewportMode === 'mobile';
  const isDesktopViewport = viewportMode === 'desktop';

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 md:z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
        <div className="mx-auto flex h-full items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/" target="_blank" rel="noopener noreferrer">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">Suite</span>
              </Link>
            </Button>
            {showMobileChrome ? (
              <>
                <Button
                  variant={mobileSurface === 'files' ? 'default' : 'ghost'}
                  size="icon-sm"
                  onClick={() => setMobileSurface('files')}
                  aria-label="Show files"
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
                <Button
                  variant={mobileSurface === 'chat' ? 'default' : 'ghost'}
                  size="icon-sm"
                  onClick={() => setMobileSurface('chat')}
                  aria-label="Show chat"
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>
                <Button
                  variant={mobileSurface === 'terminal' ? 'default' : 'ghost'}
                  size="icon-sm"
                  onClick={() => setMobileSurface('terminal')}
                  aria-label="Show terminal"
                >
                  <TerminalIcon className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant={sidebarVisible ? "default" : "ghost"}
                  size="icon-sm"
                  onClick={() => setSidebarVisible((prev) => !prev)}
                  aria-label={sidebarVisible ? 'Hide sidebar' : 'Show sidebar'}
                >
                  <PanelLeft className="h-4 w-4" />
                </Button>
                <Image src="/logo.jpg" alt="Canvas Notebook logo" width={32} height={32} className="shrink-0 border border-border" />
                <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">CANVAS NOTEBOOK</h1>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <ThemeToggle />
            {isDesktopViewport ? (
              <>
                <Button
                  variant={terminalVisible ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setTerminalVisible(!terminalVisible)}
                  className="gap-2 px-2 sm:px-3"
                >
                  <TerminalIcon className="h-4 w-4" />
                  <span className="hidden sm:inline">Terminal</span>
                </Button>
                <Button
                  variant={chatVisible ? "default" : "ghost"}
                  size="sm"
                  onClick={() => setChatVisible(!chatVisible)}
                  className="gap-2 px-2 sm:px-3"
                >
                  <MessageSquare className="h-4 w-4" />
                  <span className="hidden sm:inline">AI Chat</span>
                </Button>
                <div className="hidden lg:flex flex-col items-end shrink-0">
                    <span className="text-[10px] text-muted-foreground uppercase tracking-widest font-bold">User</span>
                    <span className="text-xs text-foreground/90">{username}</span>
                </div>
              </>
            ) : null}
            <LogoutButton />
          </div>
        </div>
      </header>

      {viewportMode === null ? (
        <main className="flex min-h-0 flex-1 overflow-hidden bg-background" />
      ) : isMobileViewport ? (
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            {mobileSurface === 'files' ? (
              <SidebarProvider className="h-full min-h-0">
                <FileBrowser />
              </SidebarProvider>
            ) : null}
            {mobileSurface === 'editor' ? <FileEditor /> : null}
            {mobileSurface === 'chat' ? <CanvasAgentChat /> : null}
            {mobileSurface === 'terminal' ? <TerminalPanel standalone /> : null}
          </div>
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 overflow-hidden relative">
          {sidebarVisible ? (
            <div
              style={{ '--desktop-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
              className="relative z-[80] w-[var(--desktop-sidebar-width)] flex-shrink-0 bg-card border-r border-border"
            >
              <div className="flex h-full flex-col">
                <div className="flex-1 min-w-0 overflow-hidden">
                  <SidebarProvider className="h-full min-h-0">
                    <FileBrowser />
                  </SidebarProvider>
                </div>
              </div>
            </div>
          ) : null}

          {sidebarVisible ? (
            <div
              aria-label="Resize file tree"
              className="hidden md:flex w-1 hover:w-1.5 bg-border hover:bg-primary/60 cursor-col-resize z-50 transition-all items-center justify-center"
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                isSidebarResizing.current = true;
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                sidebarResizeRef.current = {
                  startX: event.clientX,
                  startWidth: sidebarWidth,
                };
              }}
            >
              <div className="h-8 w-0.5 bg-muted-foreground/60" />
            </div>
          ) : null}

          <div className="flex-1 min-w-0 h-full flex flex-col relative">
            <AppLayout
              sidebar={<div />}
              sidebarHidden={true}
              terminalVisible={terminalVisible}
              main={
                <div className="flex h-full w-full overflow-hidden relative">
                  <div className="flex-1 min-w-0 bg-background">
                    <FileEditor />
                  </div>

                  {chatVisible ? (
                    <div
                      onMouseDown={startResizing}
                      className="hidden md:flex w-1 hover:w-1.5 bg-border hover:bg-primary/60 cursor-col-resize z-50 transition-all items-center justify-center"
                    >
                      <div className="h-8 w-0.5 bg-muted-foreground/60" />
                    </div>
                  ) : null}

                  <div
                    style={{
                      width: chatVisible ? `${chatWidth}px` : '0px'
                    }}
                    className={`
                      relative flex-shrink-0 bg-background border-l border-border
                      transition-all duration-300 ease-in-out overflow-hidden
                      ${chatVisible ? 'opacity-100' : 'opacity-0 pointer-events-none w-0 border-none'}
                    `}
                  >
                    <div className="flex flex-col w-full h-full relative">
                      <CanvasAgentChat onClose={() => setChatVisible(false)} />
                    </div>
                  </div>
                </div>
              }
              terminal={<TerminalPanel />}
            />
          </div>
        </main>
      )}
    </div>
  );
}
