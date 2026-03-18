"use client";

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, PanelLeft, MessageSquare, X, Terminal as TerminalIcon } from 'lucide-react';
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
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [chatVisible, setChatVisible] = useState(false);
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const isResizing = useRef(false);
  const isSidebarResizing = useRef(false);
  const viewportInitializedRef = useRef(false);
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
      setIsMobileViewport(isMobile);
      setSidebarWidth((prev) => clampSidebarWidth(prev));
      if (!viewportInitializedRef.current) {
        setSidebarVisible(!isMobile);
        viewportInitializedRef.current = true;
        return;
      }
      if (!isMobile) {
        setSidebarVisible(true);
      }
    };

    handleViewport();
    window.addEventListener('resize', handleViewport);
    return () => window.removeEventListener('resize', handleViewport);
  }, []);

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
          </div>
          <div className="flex items-center gap-1.5 md:gap-4">
            <ThemeToggle />
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
            <LogoutButton />
          </div>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 overflow-hidden relative">
        {/* Mobile Sidebar Overlay */}
        {sidebarVisible && (
          <div 
            className="md:hidden fixed inset-0 bg-background/70 z-[70] transition-opacity duration-300"
            onClick={() => setSidebarVisible(false)}
          />
        )}

        {/* Sidebar Container - Sliding on mobile, fixed on desktop */}
        <div
          style={{ '--desktop-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
          className={`
          fixed md:relative top-0 left-0 bottom-0 z-[80] md:z-auto
          w-[280px] md:w-[var(--desktop-sidebar-width)] flex-shrink-0 bg-card border-r border-border
          transition-all duration-300 ease-in-out md:transition-none
          ${sidebarVisible 
            ? 'translate-x-0 opacity-100' 
            : '-translate-x-full md:hidden opacity-0 pointer-events-none'
          }
        `}
        >
          <div className="flex flex-col h-full">
            <div className="md:hidden p-4 border-b border-border flex justify-between items-center bg-muted/40">
              <span className="font-bold text-sm tracking-widest uppercase opacity-70 text-foreground">Files</span>
              <button onClick={() => setSidebarVisible(false)} className="border border-transparent p-1 hover:border-border hover:bg-accent">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 min-w-0 overflow-hidden">
              <SidebarProvider className="h-full min-h-0">
                <FileBrowser />
              </SidebarProvider>
            </div>
          </div>
        </div>

        {sidebarVisible && (
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
        )}

        <div className="flex-1 min-w-0 h-full flex flex-col relative">
          <AppLayout
            sidebar={<div />} // Handled manually for better mobile control
            sidebarHidden={true}
            terminalVisible={terminalVisible && !isMobileViewport}
            main={
              <div className="flex h-full w-full overflow-hidden relative">
                {/* Main Editor Area */}
                <div className="flex-1 min-w-0 bg-background">
                  <FileEditor />
                </div>

                {/* Mobile Chat Backdrop Overlay */}
                {chatVisible && (
                  <div 
                    className="md:hidden fixed inset-0 bg-background/70 z-[70] transition-opacity duration-300"
                    onClick={() => setChatVisible(false)}
                  />
                )}

                {/* Resize Handle - Desktop Only */}
                {chatVisible && (
                  <div 
                    onMouseDown={startResizing}
                    className="hidden md:flex w-1 hover:w-1.5 bg-border hover:bg-primary/60 cursor-col-resize z-50 transition-all items-center justify-center"
                  >
                    <div className="h-8 w-0.5 bg-muted-foreground/60" />
                  </div>
                )}

                {/* Chat Panel - Desktop: Resizable side panel, Mobile: Fullscreen overlay */}
                {!isMobileViewport ? (
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
                ) : null}
              </div>
            }
            terminal={<TerminalPanel />}
          />

          {/* Fullscreen Mobile Chat */}
          {chatVisible && isMobileViewport && (
            <div className="fixed inset-0 z-[100] bg-background flex flex-col">
              <div className="flex items-center justify-between p-2 bg-card border-b border-border">
                <div className="flex items-center gap-2 px-2">
                  <MessageSquare size={14} className="text-primary" />
                  <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Canvas Chat</span>
                </div>
                <button 
                  onClick={() => setChatVisible(false)}
                  className="border border-transparent p-2 text-muted-foreground hover:border-border hover:bg-accent"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <CanvasAgentChat onClose={() => setChatVisible(false)} />
              </div>
            </div>
          )}

          {/* Fullscreen Mobile Terminal */}
          {terminalVisible && isMobileViewport && (
            <div className="fixed inset-0 z-[100] bg-background flex flex-col">
              <div className="flex items-center justify-between p-2 bg-card border-b border-border">
                <div className="flex items-center gap-2 px-2">
                  <TerminalIcon size={14} className="text-primary" />
                  <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Terminal</span>
                </div>
                <button 
                  onClick={() => setTerminalVisible(false)}
                  className="border border-transparent p-2 text-muted-foreground hover:border-border hover:bg-accent"
                >
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-hidden pb-safe">
                <TerminalPanel />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
