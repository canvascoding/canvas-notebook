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
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

import { AppLauncher } from '@/app/components/AppLauncher';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
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

const LEFT_SIDEBAR_MIN = 410;
const LEFT_SIDEBAR_MAX = 940;
const MIN_EDITOR_WIDTH = 360;
const NOTEBOOK_OPEN_FILE_STORAGE_KEY = 'canvas.notebookOpenFilePath';
const NOTEBOOK_DESKTOP_SIDEBAR_VISIBLE_STORAGE_KEY = 'canvas.notebookDesktopSidebarVisible';

function normalizeNotebookFilePath(path: string | null) {
  const normalized = path?.replace(/^\.\/|\/+$/g, '').trim();
  return normalized || null;
}

function readStoredNotebookOpenFilePath() {
  if (typeof window === 'undefined') return null;

  try {
    return normalizeNotebookFilePath(window.localStorage.getItem(NOTEBOOK_OPEN_FILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStoredNotebookOpenFilePath(path: string) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(NOTEBOOK_OPEN_FILE_STORAGE_KEY, path);
  } catch {
    // Non-critical: the notebook can still open files without persistence.
  }
}

function clearStoredNotebookOpenFilePath() {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(NOTEBOOK_OPEN_FILE_STORAGE_KEY);
  } catch {
    // Non-critical: stale local UI state can be ignored on the next load.
  }
}

function readStoredDesktopSidebarVisible() {
  if (typeof window === 'undefined') return true;

  try {
    const stored = window.localStorage.getItem(NOTEBOOK_DESKTOP_SIDEBAR_VISIBLE_STORAGE_KEY);
    if (stored === null) return true;
    return stored === 'true';
  } catch {
    return true;
  }
}

function writeStoredDesktopSidebarVisible(visible: boolean) {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(NOTEBOOK_DESKTOP_SIDEBAR_VISIBLE_STORAGE_KEY, String(visible));
  } catch {
    // Non-critical: the desktop explorer can fall back to its default visibility.
  }
}

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

export function DashboardShell({ hintEnabled = true }: { hintEnabled?: boolean }) {
  const tNotebook = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const tChat = useTranslations('chat');
  const tNav = useTranslations('navigation');
  const searchParams = useSearchParams();
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(410);
  const [chatVisible, setChatVisible] = useState(true);
  const [desktopChatMode, setDesktopChatMode] = useState<DesktopChatMode>('side');
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [chatWidth, setChatWidth] = useState(420);
  const [viewportWidth, setViewportWidth] = useState(420);
  const [mobileSurface, setMobileSurface] = useState<MobileSurface>('editor');
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [mobileChatMounted, setMobileChatMounted] = useState(false);
  const isResizing = useRef(false);
  const isSidebarResizing = useRef(false);
  const sidebarResizeRef = useRef<{
    startX: number;
    startWidth: number;
  } | null>(null);
  const openedPathRef = useRef<string | null>(null);
  const initialNotebookStateResolvedRef = useRef(false);
  const desktopDefaultChatAppliedRef = useRef(false);
  const prevViewportModeRef = useRef<'mobile' | 'desktop' | null>(null);
  const previousCurrentFilePathRef = useRef<string | null>(null);
  const currentFile = useFileStore((state) => state.currentFile);
  const currentDirectory = useFileStore((state) => state.currentDirectory);

  const currentDirectoryLabel =
    currentDirectory === '.' ? 'Workspace /' : `/${currentDirectory}`;
  const hasSessionTarget = searchParams.has('session');
  const hasStoredInitialPrompt =
    typeof window !== 'undefined'
    && Boolean(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY));
  const shouldForceChatOpen = hasSessionTarget || hasStoredInitialPrompt;
  const openDesktopSideChat = useCallback(() => {
    setChatVisible(true);
    setDesktopChatMode('side');
  }, []);

  const openMobileChat = useCallback(() => {
    setMobileChatMounted(true);
    setMobileExplorerOpen(false);
    setMobileChatOpen(true);
  }, []);

  const toggleMobileChat = useCallback(() => {
    setMobileChatMounted(true);
    setMobileExplorerOpen(false);
    setMobileChatOpen((current) => !current);
  }, []);

  const setDesktopSidebarVisible = useCallback((nextVisible: boolean | ((current: boolean) => boolean)) => {
    setSidebarVisible((current) => {
      const resolvedVisible =
        typeof nextVisible === 'function' ? nextVisible(current) : nextVisible;
      writeStoredDesktopSidebarVisible(resolvedVisible);
      return resolvedVisible;
    });
  }, []);

  const openInitialNotebookChat = useCallback((mode: 'mobile' | 'desktop') => {
    setChatVisible(true);

    if (mode === 'desktop') {
      setDesktopChatMode('fullscreen');
      return;
    }

    setMobileSurface('editor');
    setMobileChatOpen(false);
  }, []);

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

  const openNotebookFile = useCallback(async (path: string) => {
    const normalizedPath = normalizeNotebookFilePath(path);
    if (!normalizedPath) return;

    await useFileStore.getState().revealAndLoadFile(normalizedPath);

    const loadedPath = useFileStore.getState().currentFile?.path ?? null;
    if (loadedPath === normalizedPath) {
      writeStoredNotebookOpenFilePath(normalizedPath);
    } else {
      clearStoredNotebookOpenFilePath();
    }

    useFileStore.getState().setMobileSurface('editor');
  }, []);

  useEffect(() => {
    const targetPath = normalizeNotebookFilePath(searchParams.get('path'));
    if (targetPath && openedPathRef.current !== targetPath) {
      openedPathRef.current = targetPath;
      void openNotebookFile(targetPath);

      if (viewportMode === 'desktop') {
        queueMicrotask(openDesktopSideChat);
      }
    }

    const sessionParam = searchParams.get('session');
    if (sessionParam) {
      queueMicrotask(() => {
        setChatVisible(true);
        if (viewportMode === 'mobile') {
          openMobileChat();
        }
      });
    }
  }, [openDesktopSideChat, openMobileChat, openNotebookFile, searchParams, viewportMode]);

  useEffect(() => {
    if (viewportMode === null || initialNotebookStateResolvedRef.current) return;

    initialNotebookStateResolvedRef.current = true;

    const targetPath = normalizeNotebookFilePath(searchParams.get('path'));
    if (targetPath) {
      return;
    }

    const storedPath = readStoredNotebookOpenFilePath();
    if (storedPath) {
      openedPathRef.current = storedPath;
      void openNotebookFile(storedPath);
      if (viewportMode === 'desktop') {
        queueMicrotask(openDesktopSideChat);
      }
      return;
    }

    useFileStore.getState().clearCurrentFile();
    queueMicrotask(() => openInitialNotebookChat(viewportMode));
  }, [openDesktopSideChat, openInitialNotebookChat, openNotebookFile, searchParams, viewportMode]);

  useEffect(() => {
    previousCurrentFilePathRef.current = useFileStore.getState().currentFile?.path ?? null;

    const unsubscribe = useFileStore.subscribe((state) => {
      const nextPath = state.currentFile?.path ?? null;
      const previousPath = previousCurrentFilePathRef.current;
      previousCurrentFilePathRef.current = nextPath;

      if (nextPath && nextPath !== previousPath) {
        writeStoredNotebookOpenFilePath(nextPath);
      }

      if (!nextPath || nextPath === previousPath || viewportMode !== 'desktop') {
        return;
      }

      openDesktopSideChat();
    });

    return unsubscribe;
  }, [openDesktopSideChat, viewportMode]);

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

  const handleClosePreview = useCallback(() => {
    useFileStore.getState().clearCurrentFile();
    clearStoredNotebookOpenFilePath();
    setChatVisible(true);

    if (viewportMode === 'desktop') {
      setDesktopChatMode('fullscreen');
      return;
    }

    if (viewportMode === 'mobile') {
      setMobileSurface('editor');
      setMobileExplorerOpen(false);
      openMobileChat();
    }
  }, [openMobileChat, viewportMode]);

  useEffect(() => {
    const handleViewport = () => {
      const nextWidth = window.innerWidth;
      const isMobile = nextWidth < 768;
      const nextMode = isMobile ? 'mobile' : 'desktop';
      setViewportWidth((current) => (current === nextWidth ? current : nextWidth));
      setViewportMode((current) => (current === nextMode ? current : nextMode));

      if (!isMobile) {
        setSidebarWidth((prev) => {
          const clampedWidth = clampSidebarWidth(prev);
          return clampedWidth === prev ? prev : clampedWidth;
        });
      }

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
          setMobileChatMounted(true);
          setMobileChatOpen(true);
        } else {
          setChatVisible(false);
          setMobileSurface('editor');
        }
      } else {
        setSidebarVisible(readStoredDesktopSidebarVisible());
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

  useEffect(() => {
    if (!mobileChatOpen || viewportMode !== 'mobile') return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMobileChatOpen(false);
    };

    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [mobileChatOpen, viewportMode]);

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
      setDesktopSidebarVisible((current) => !current);
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
  }, [handleDesktopChatPrimaryAction, setDesktopSidebarVisible, viewportMode]);

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

  const isMobileViewport = viewportMode === 'mobile';
  const isDesktopViewport = viewportMode === 'desktop';
  const isDesktopChatSideVisible = isDesktopViewport && chatVisible && desktopChatMode === 'side';
  const isDesktopChatFullscreen = isDesktopViewport && chatVisible && desktopChatMode === 'fullscreen';
  const desktopChatWrapperStyle =
    desktopChatMode === 'side'
      ? ({ width: chatVisible ? `${chatWidth}px` : '0px' } as CSSProperties)
      : undefined;
  const chatContainerWidth = isDesktopChatFullscreen ? viewportWidth : chatWidth;

  return (
    <FileWatcherProvider>
    <HintProvider page="notebook" enabled={hintEnabled}>
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
      <header className="z-40 md:z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)]">
        <div className="relative mx-auto flex h-full items-center justify-between px-4">
          {/* Left side: always back link + title (desktop) */}
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
              <Link href="/">
                <ArrowLeft className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('suite')}</span>
              </Link>
            </Button>

          </div>

          {/* Center toggle group: both mobile and desktop */}
          <div className="absolute left-1/2 top-1/2 z-[60] flex -translate-x-1/2 -translate-y-1/2 items-center">
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
                    setDesktopSidebarVisible((prev) => !prev);
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
                          className={cn(
                            'gap-2',
                            isMobileViewport ? 'rounded-full' : 'rounded-l-full rounded-r-none'
                          )}
                          onClick={() => {
                            if (isMobileViewport) {
                              toggleMobileChat();
                            } else {
                              handleDesktopChatPrimaryAction();
                            }
                          }}
                        >
                          <MessageSquare className="h-4 w-4" />
                          <span className="hidden sm:inline">{tCommon('aiChat')}</span>
                        </Button>
                        {!isMobileViewport && (
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
                        )}
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
          <div className="relative z-50 flex items-center gap-1.5 md:gap-4">
            <AppLauncher />
            <ThemeToggle />
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
                <FileEditor onClosePreview={handleClosePreview} />
              ) : (
                <MobileNotebookEmptyState
                  onOpenExplorer={() => setMobileExplorerOpen(true)}
                  onOpenChat={openMobileChat}
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
          {mobileChatMounted ? (
            <div
              id="onboarding-notebook-chat"
              role="dialog"
              aria-modal={mobileChatOpen}
              aria-hidden={!mobileChatOpen}
              aria-labelledby="notebook-mobile-chat-title"
              className={cn(
                'fixed inset-x-0 top-0 bottom-0 z-[90] flex h-[100dvh] max-h-[100dvh] w-full flex-col overflow-hidden overscroll-contain border-l border-border bg-background shadow-lg transition-[transform,opacity,visibility] duration-300 ease-in-out md:hidden',
                mobileChatOpen
                  ? 'visible translate-x-0 opacity-100'
                  : 'invisible pointer-events-none translate-x-full opacity-0'
              )}
            >
              <div className="shrink-0 border-b border-border bg-background/95 px-4 py-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] text-left">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <h2 id="notebook-mobile-chat-title" className="text-base font-semibold text-foreground">
                      {tCommon('aiChat')}
                    </h2>
                    <p className="sr-only">
                      {tChat('metadataDescription')}
                    </p>
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
              </div>
              <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
                <CanvasAgentChat
                  initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
                  hideNavHeader={true}
                  chatContainerWidth={viewportWidth}
                  isSurfaceVisible={mobileChatOpen}
                />
              </div>
            </div>
          ) : null}
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 overflow-hidden relative">
          {sidebarVisible ? (
            <div
              id="onboarding-notebook-fileBrowser"
              style={{ '--desktop-sidebar-width': `${sidebarWidth}px` } as CSSProperties}
              className="relative z-[80] min-w-[410px] w-[var(--desktop-sidebar-width)] flex-shrink-0 bg-card border-r border-border"
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
                    <FileEditor onClosePreview={handleClosePreview} />
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
                        chatContainerWidth={chatContainerWidth}
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
