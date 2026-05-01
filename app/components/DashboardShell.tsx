"use client";

import { useState, useRef, useCallback, useEffect, type CSSProperties } from 'react';

import { Link } from '@/i18n/navigation';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  ChevronDown,
  Files,
  Maximize2,
  MessageSquare,
  PanelRight,
  Terminal as TerminalIcon,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { LogoutButton } from '@/app/components/LogoutButton';
import { AppLauncher } from '@/app/components/AppLauncher';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
import { HelpDropdown } from '@/app/components/onboarding/HelpDropdown';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { AppLayout } from '@/app/components/layout/AppLayout';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { ThemeToggle } from '@/app/components/ThemeToggle';

import { useFileStore } from '@/app/store/file-store';
import { FileWatcherProvider } from '@/app/hooks/FileWatcherContext';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';



type MobileSurface = 'editor' | 'terminal';
type DesktopChatMode = 'side' | 'fullscreen';

const LEFT_SIDEBAR_MIN = 390;
const LEFT_SIDEBAR_MAX = 940;
const MIN_EDITOR_WIDTH = 360;

function getSidebarMaxWidth() {
  if (typeof window === 'undefined') {
    return LEFT_SIDEBAR_MIN;
  }

  return Math.min(LEFT_SIDEBAR_MAX, Math.max(LEFT_SIDEBAR_MIN, window.innerWidth - MIN_EDITOR_WIDTH));
}

function clampSidebarWidth(width: number) {
  return Math.min(LEFT_SIDEBAR_MAX, getSidebarMaxWidth(), Math.max(LEFT_SIDEBAR_MIN, width));
}

function MobileNotebookEmptyState({
  onOpenExplorer,
  onOpenChat,
}: {
  onOpenExplorer: () => void;
  onOpenChat: () => void;
}) {
  const t = useTranslations('notebook');
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top,_hsl(var(--primary)/0.14),_transparent_48%),linear-gradient(180deg,_hsl(var(--muted)/0.36),_transparent_52%)] px-4 py-8">
      <div className="w-full max-w-sm rounded-[28px] border border-border/80 bg-background/95 p-6 shadow-[0_24px_80px_-32px_hsl(var(--foreground)/0.45)] backdrop-blur">
        <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/70 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
          <Files className="h-3.5 w-3.5" />
          {t('badge')}
        </div>
        <div className="mt-5 space-y-3">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t('emptyStateTitle')}
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            {t('emptyStateDescription')}
          </p>
        </div>
        <div className="mt-6 flex flex-col gap-3">
          <Button className="h-12 justify-center gap-2 rounded-2xl text-sm" onClick={onOpenExplorer}>
            <Files className="h-4 w-4" />
            {t('selectFile')}
          </Button>
          <Button
            variant="outline"
            className="h-12 justify-center gap-2 rounded-2xl text-sm"
            onClick={onOpenChat}
          >
            <MessageSquare className="h-4 w-4" />
            {t('openChat')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DashboardShell() {
  const tNotebook = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const tChat = useTranslations('chat');
  const tNav = useTranslations('navigation');
  const searchParams = useSearchParams();
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(390);
  const [chatVisible, setChatVisible] = useState(true);
  const [desktopChatMode, setDesktopChatMode] = useState<DesktopChatMode>('side');
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('editor');
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const isResizing = useRef(false);
  const isSidebarResizing = useRef(false);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const openedPathRef = useRef<string | null>(null);
  const desktopDefaultChatAppliedRef = useRef(false);
  const prevViewportModeRef = useRef<'mobile' | 'desktop' | null>(null);
  const currentFile = useFileStore((state) => state.currentFile);
  const currentDirectory = useFileStore((state) => state.currentDirectory);

  const currentDirectoryLabel =
    currentDirectory === '.' ? 'Workspace /' : `/${currentDirectory}`;
  const hasSessionTarget = searchParams.has('session');
  const hasStoredInitialPrompt =
    typeof window !== 'undefined'
    && Boolean(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY));
  const shouldForceChatOpen = hasSessionTarget || hasStoredInitialPrompt;

  useEffect(() => {
    const storedWidth = Number(window.localStorage.getItem('canvas.leftSidebarWidth'));
    if (!Number.isFinite(storedWidth) || storedWidth < LEFT_SIDEBAR_MIN) {
      window.localStorage.removeItem('canvas.leftSidebarWidth');
      return;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSidebarWidth(clampSidebarWidth(storedWidth));
  }, []);

  useEffect(() => {
    window.localStorage.setItem('canvas.leftSidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);



  useEffect(() => {
    window.localStorage.setItem('canvas.terminalVisible', String(terminalVisible));
  }, [terminalVisible]);

  useEffect(() => {
    const storedTerminal = window.localStorage.getItem('canvas.terminalVisible');
    if (storedTerminal !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTerminalVisible(storedTerminal === 'true');
    }
  }, []);

  useEffect(() => {
    const stored = window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY);
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChatVisible(true);
    }
  }, []);

  useEffect(() => {
    const targetPath = searchParams.get('path');
    if (targetPath && openedPathRef.current !== targetPath) {
      openedPathRef.current = targetPath;
      const { loadFile, setCurrentDirectory } = useFileStore.getState();
      const trimmed = targetPath.replace(/\/+$/, '');
      const lastSlash = trimmed.lastIndexOf('/');
      const parentDir = lastSlash > 0 ? trimmed.slice(0, lastSlash) : '.';
      setCurrentDirectory(parentDir || '.');
      void loadFile(targetPath, true);
      useFileStore.getState().setMobileSurface('editor');
    }

    const sessionParam = searchParams.get('session');
    if (sessionParam) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setChatVisible(true);
    }
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

  const openDesktopChat = useCallback((mode: DesktopChatMode) => {
    setDesktopChatMode(mode);
    setChatVisible(true);
  }, []);

  const handleDesktopChatPrimaryAction = useCallback(() => {
    if (!chatVisible) {
      openDesktopChat('side');
      return;
    }

    if (desktopChatMode === 'fullscreen') {
      setDesktopChatMode('side');
      return;
    }

    setChatVisible(false);
  }, [chatVisible, desktopChatMode, openDesktopChat]);

  useEffect(() => {
    const handleViewport = () => {
      const isMobile = window.innerWidth < 768;
      const nextMode = isMobile ? 'mobile' : 'desktop';
      setViewportMode(nextMode);
      setSidebarWidth((prev) => clampSidebarWidth(prev));

      // Only reset layout state when the viewport mode actually changes (mobile ↔ desktop).
      // Some browsers fire synthetic resize events on tab switch which would otherwise
      // reset panel visibility to defaults.
      if (nextMode === prevViewportModeRef.current) return;
      prevViewportModeRef.current = nextMode;

      if (isMobile) {
        setSidebarVisible(false);
        setTerminalVisible(false);
        setMobileExplorerOpen(false);
        // Check if there's an initial prompt in sessionStorage - if so, open chat
        const stored = window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY);
        if (stored) {
          setChatVisible(true);
          setMobileChatOpen(true);
        } else {
          setChatVisible(false);
          setMobileSurface('editor');
        }
      } else {
        setSidebarVisible(true);
        if (!desktopDefaultChatAppliedRef.current) {
          desktopDefaultChatAppliedRef.current = true;
          setChatVisible(true);
        }
      }
    };

    handleViewport();
    window.addEventListener('resize', handleViewport);
    return () => window.removeEventListener('resize', handleViewport);
  }, [shouldForceChatOpen]);

  const handleMobileFileSelect = useCallback(() => {
    if (viewportMode !== 'mobile') return;
    setMobileSurface('editor');
    setMobileExplorerOpen(false);
    setMobileChatOpen(false);
  }, [viewportMode]);

  // Handle file opens from non-FileBrowser contexts (e.g. chat file references)
  useEffect(() => {
    let prevCount = useFileStore.getState().mobileFileOpenedCount;
    const unsub = useFileStore.subscribe((state) => {
      if (state.mobileFileOpenedCount !== prevCount) {
        prevCount = state.mobileFileOpenedCount;
        if (viewportMode !== 'mobile') return;
        setMobileSurface('editor');
        setMobileExplorerOpen(false);
        setMobileChatOpen(false);
      }
    });
    return unsub;
  }, [viewportMode]);

  useEffect(() => {
    const handleDesktopSidebarToggle = () => {
      if (viewportMode !== 'desktop') {
        return;
      }
      setSidebarVisible((current) => !current);
    };

    const handleDesktopChatToggle = () => {
      if (viewportMode !== 'desktop') {
        return;
      }
      handleDesktopChatPrimaryAction();
    };

    window.addEventListener('notebook-desktop-toggle-sidebar', handleDesktopSidebarToggle);
    window.addEventListener('notebook-desktop-toggle-chat', handleDesktopChatToggle);
    return () => {
      window.removeEventListener('notebook-desktop-toggle-sidebar', handleDesktopSidebarToggle);
      window.removeEventListener('notebook-desktop-toggle-chat', handleDesktopChatToggle);
    };
  }, [handleDesktopChatPrimaryAction, viewportMode]);

  useEffect(() => {
    const handleKeyboardToggle = (event: KeyboardEvent) => {
      if (viewportMode !== 'desktop') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'j') {
        event.preventDefault();
        setTerminalVisible((prev) => !prev);
      } else if (key === 'k') {
        event.preventDefault();
        handleDesktopChatPrimaryAction();
      }
    };
    window.addEventListener('keydown', handleKeyboardToggle);
    return () => window.removeEventListener('keydown', handleKeyboardToggle);
  }, [viewportMode, handleDesktopChatPrimaryAction]);

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
  const isDesktopChatSideVisible = isDesktopViewport && chatVisible && desktopChatMode === 'side';
  const isDesktopChatFullscreen = isDesktopViewport && chatVisible && desktopChatMode === 'fullscreen';
  const desktopChatWrapperStyle =
    desktopChatMode === 'side'
      ? ({ width: chatVisible ? `${chatWidth}px` : '0px' } as CSSProperties)
      : undefined;

  return (
    <FileWatcherProvider>
    <HintProvider page="notebook">
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 md:z-40 h-16 flex-shrink-0 border-b border-border bg-background/95">
        <div className="relative mx-auto flex h-full items-center justify-between px-4">
          {/* Left side: always back link + title (desktop) */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/" target="_blank" rel="noopener noreferrer">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>
            {!showMobileChrome && (
              <h1 className="hidden md:block text-lg md:text-2xl font-bold truncate">
                {tNav('canvasNotebook')}
              </h1>
            )}
          </div>

          {/* Center toggle group: both mobile and desktop */}
          <div className="absolute left-1/2 top-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 items-center">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/80 bg-background/95 p-1 shadow-sm">
              {/* Explorer toggle */}
              <Button
                variant={isMobileViewport ? (mobileExplorerOpen ? 'default' : 'ghost') : (sidebarVisible ? 'default' : 'ghost')}
                size="sm"
                className="gap-2 rounded-full"
                onClick={() => {
                  if (isMobileViewport) {
                    setMobileExplorerOpen(true);
                    setMobileChatOpen(false);
                  } else {
                    setSidebarVisible((prev) => !prev);
                  }
                }}
                aria-label={isMobileViewport ? tNav('openFileExplorer') : (sidebarVisible ? tNav('hideSidebar') : tNav('showSidebar'))}
              >
                <Files className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('explorer')}</span>
              </Button>

              {/* Terminal toggle */}
              <Button
                variant={isMobileViewport ? (mobileSurface === 'terminal' ? 'default' : 'ghost') : (terminalVisible ? 'default' : 'ghost')}
                size="sm"
                className="gap-2 rounded-full"
                onClick={() => {
                  if (isMobileViewport) {
                    setMobileExplorerOpen(false);
                    setMobileChatOpen(false);
                    setMobileSurface((current) => (current === 'terminal' ? 'editor' : 'terminal'));
                  } else {
                    setTerminalVisible((prev) => !prev);
                  }
                }}
                aria-label={tNav('showTerminal')}
              >
                <TerminalIcon className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('terminal')}</span>
              </Button>

              {/* Chat toggle */}
              <DropdownMenu modal={false}>
                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="flex items-center">
                        <Button
                          variant={isMobileViewport ? (mobileChatOpen ? 'default' : 'ghost') : (chatVisible ? 'default' : 'ghost')}
                          size="sm"
                          className="gap-2 rounded-l-full rounded-r-none"
                          onClick={() => {
                            if (isMobileViewport) {
                              setMobileExplorerOpen(false);
                              setMobileChatOpen((prev) => !prev);
                            } else {
                              handleDesktopChatPrimaryAction();
                            }
                          }}
                        >
                          <MessageSquare className="h-4 w-4" />
                          <span className="hidden sm:inline">{tCommon('aiChat')}</span>
                        </Button>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant={isMobileViewport ? (mobileChatOpen ? 'default' : 'ghost') : (chatVisible ? 'default' : 'ghost')}
                            size="sm"
                            className={`rounded-l-none rounded-r-full border-l ${
                              ((!isMobileViewport && chatVisible) || (isMobileViewport && mobileChatOpen))
                                ? 'border-primary-foreground/15'
                                : 'border-border/60'
                            }`}
                            aria-label={tNav('openChatModeMenu')}
                          >
                            <ChevronDown className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      {tCommon('aiChat')} ({typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'}K)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuRadioGroup
                    value={desktopChatMode}
                    onValueChange={(value) => openDesktopChat(value as DesktopChatMode)}
                  >
                    <DropdownMenuRadioItem value="side">
                      <PanelRight className="h-4 w-4" />
                      {tCommon('openInSidePanel')}
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="fullscreen">
                      <Maximize2 className="h-4 w-4" />
                      {tCommon('openFullscreen')}
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Right side: help, theme, logout */}
          <div className="flex items-center gap-1.5 md:gap-4">
            <AppLauncher />
            <HelpDropdown page="notebook" />
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>

      {viewportMode === null ? (
        <main className="flex min-h-0 flex-1 overflow-hidden bg-background" />
      ) : isMobileViewport ? (
        <main className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {mobileSurface === 'editor' ? (
              currentFile ? (
                <FileEditor />
              ) : (
                <MobileNotebookEmptyState
                  onOpenExplorer={() => setMobileExplorerOpen(true)}
                  onOpenChat={() => setMobileChatOpen(true)}
                />
              )
            ) : null}
            {mobileSurface === 'terminal' ? <TerminalPanel standalone /> : null}
          </div>
          <Sheet open={mobileExplorerOpen} onOpenChange={setMobileExplorerOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              className="w-full max-w-none gap-0 border-r p-0 sm:max-w-none"
            >
              <SheetHeader className="border-b border-border bg-background/95 px-4 py-3 text-left">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <SheetTitle className="text-base">{tCommon('explorer')}</SheetTitle>
                    <SheetDescription className="truncate text-xs">
                      {currentDirectoryLabel}
                    </SheetDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setMobileExplorerOpen(false)}
                    aria-label={tNav('closeExplorer')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </SheetHeader>
              <div className="min-h-0 flex-1">
                <SidebarProvider className="h-full min-h-0">
                  <FileBrowser variant="mobile-sheet" onFileSelect={handleMobileFileSelect} />
                </SidebarProvider>
              </div>
            </SheetContent>
          </Sheet>
          <Sheet open={mobileChatOpen} onOpenChange={setMobileChatOpen}>
            <SheetContent
              side="right"
              showCloseButton={false}
              className="w-full max-w-none gap-0 border-l p-0 sm:max-w-none"
            >
              <SheetHeader className="border-b border-border bg-background/95 px-4 py-3 text-left">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <SheetTitle className="text-base">{tCommon('aiChat')}</SheetTitle>
                    <SheetDescription className="sr-only">
                      {tChat('metadataDescription')}
                    </SheetDescription>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setMobileChatOpen(false)}
                    aria-label={tNav('closeChat')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </SheetHeader>
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                <CanvasAgentChat
                  initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
                  hideNavHeader={true}
                  chatContainerWidth={chatWidth}
                  isSurfaceVisible={mobileChatOpen}
                />
              </div>
            </SheetContent>
          </Sheet>
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 overflow-hidden relative">
          {sidebarVisible ? (
            <div
              id="onboarding-notebook-fileBrowser"
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
              aria-label={tNotebook('resizeFileTree')}
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
                  <div id="onboarding-notebook-editor" className="flex-1 min-w-0 bg-background">
                    <FileEditor />
                  </div>

                  {isDesktopChatSideVisible ? (
                    <div
                      onMouseDown={startResizing}
                      className="hidden md:flex w-1 hover:w-1.5 bg-border hover:bg-primary/60 cursor-col-resize z-50 transition-all items-center justify-center"
                    >
                      <div className="h-8 w-0.5 bg-muted-foreground/60" />
                    </div>
                  ) : null}

                  <div
                    style={desktopChatWrapperStyle}
                    className={
                      desktopChatMode === 'fullscreen'
                        ? `
                          absolute inset-0 z-[70] overflow-hidden bg-background shadow-[0_0_0_1px_hsl(var(--border)),0_24px_60px_-24px_hsl(var(--foreground)/0.45)]
                          transition-all duration-300 ease-in-out
                          ${isDesktopChatFullscreen ? 'opacity-100' : 'pointer-events-none opacity-0'}
                        `
                        : `
                          relative flex-shrink-0 overflow-hidden border-l border-border bg-background
                          transition-all duration-300 ease-in-out
                          ${chatVisible ? 'opacity-100' : 'pointer-events-none w-0 border-none opacity-0'}
                        `
                    }
                  >
                    <div id="onboarding-notebook-chat" className="flex flex-col w-full h-full relative">
                      <CanvasAgentChat
                        initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
                        hideNavHeader={true}
                        chatContainerWidth={isDesktopChatFullscreen ? window.innerWidth : chatWidth}
                        isSurfaceVisible={chatVisible}
                      />
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
    </HintProvider>
    </FileWatcherProvider>
  );
}
