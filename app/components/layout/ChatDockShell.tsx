'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  Suspense,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ChevronDown, Maximize2, MessageSquare, PanelRight, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';

import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { AppBackButton } from '@/app/components/navigation/AppBackButton';
import { AppLauncher } from '@/app/components/AppLauncher';
import { NotificationBell } from '@/app/components/notifications/NotificationBell';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
import { ResizeHandle, usePanelResize } from '@/app/components/layout/ResizeHandle';
import {
  handleOpenChatSessionEvent,
  OPEN_CHAT_SESSION_EVENT,
} from '@/app/lib/chat/open-chat-session-event';
import { getChatNavigationIntent } from '@/app/lib/chat/chat-navigation-intent';
import { useForcedChatSession } from '@/app/components/canvas-agent-chat/useForcedChatSession';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import { useWorkspaceStore } from '@/app/store/workspace-store';
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
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type DesktopChatMode = 'side' | 'fullscreen';

function ChatNavigationIntentObserver({
  onChange,
}: {
  onChange: (intent: ReturnType<typeof getChatNavigationIntent>) => void;
}) {
  const searchParams = useSearchParams();
  const { sessionId, workspaceId, shouldOpenChat } = getChatNavigationIntent(searchParams);

  useEffect(() => {
    onChange({ sessionId, workspaceId, shouldOpenChat });
  }, [onChange, sessionId, shouldOpenChat, workspaceId]);

  return null;
}

const CHAT_WIDTH_MIN = 390;
const CHAT_WIDTH_MAX = 600;
const DEFAULT_CHAT_WIDTH = 420;
const MAIN_CONTENT_MIN_WIDTH = 480;

function getStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
}

function getStoredChatWidth(key: string) {
  if (typeof window === 'undefined') return DEFAULT_CHAT_WIDTH;
  const stored = Number(window.localStorage.getItem(key));
  if (!Number.isFinite(stored)) return DEFAULT_CHAT_WIDTH;
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, stored));
}

type ChatDockShellProps = {
  children: ReactNode;
  title: ReactNode;
  backHref: string;
  preferBackFallback?: boolean;
  requestContext: ChatRequestContext;
  storageKeyPrefix: string;
  hintPage?: string;
  hintEnabled?: boolean;
  defaultChatVisible?: boolean;
  chatVisibleStorageKey?: string;
  chatWidthStorageKey?: string;
  headerCenter?: ReactNode;
  headerActions?: ReactNode;
  headerBelow?: ReactNode;
  mainClassName?: string;
  titleClassName?: string;
};

export function ChatDockShell({
  children,
  title,
  backHref,
  preferBackFallback = false,
  requestContext,
  storageKeyPrefix,
  hintPage = '',
  hintEnabled = true,
  defaultChatVisible = true,
  chatVisibleStorageKey = `${storageKeyPrefix}.chatVisible`,
  chatWidthStorageKey = `${storageKeyPrefix}.chatWidth`,
  headerCenter,
  headerActions,
  headerBelow,
  mainClassName,
  titleClassName,
}: ChatDockShellProps) {
  const tCommon = useTranslations('common');
  const tNav = useTranslations('navigation');
  const tChat = useTranslations('chat');
  const [navigationIntent, setNavigationIntent] = useState<ReturnType<typeof getChatNavigationIntent>>(() => ({
    sessionId: null,
    workspaceId: null,
    shouldOpenChat: false,
  }));
  const routeSessionId = navigationIntent.sessionId;
  const shouldOpenRouteChat = navigationIntent.shouldOpenChat;
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const [chatVisible, setChatVisible] = useState(defaultChatVisible);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [desktopChatMode, setDesktopChatMode] = useState<DesktopChatMode>('side');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [hasMounted, setHasMounted] = useState(false);
  const {
    forceSession,
    forcedSessionId: forcedChatSessionId,
    requestId: forcedSessionRequestId,
  } = useForcedChatSession(routeSessionId);
  const desktopMainRef = useRef<HTMLElement | null>(null);
  const desktopChatWrapperRef = useRef<HTMLDivElement | null>(null);
  const prevViewportModeRef = useRef<'mobile' | 'desktop' | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      setChatVisible(getStoredBoolean(chatVisibleStorageKey, defaultChatVisible));
      setChatWidth(getStoredChatWidth(chatWidthStorageKey));
      setHasMounted(true);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [chatVisibleStorageKey, chatWidthStorageKey, defaultChatVisible]);

  useEffect(() => {
    if (!hasMounted) return;
    window.localStorage.setItem(chatVisibleStorageKey, String(chatVisible));
  }, [chatVisible, chatVisibleStorageKey, hasMounted]);

  useEffect(() => {
    if (!hasMounted) return;
    window.localStorage.setItem(chatWidthStorageKey, String(chatWidth));
  }, [chatWidth, chatWidthStorageKey, hasMounted]);

  useEffect(() => {
    const handleViewport = () => {
      const nextMode = window.innerWidth < 768 ? 'mobile' : 'desktop';
      setViewportMode(nextMode);
      setViewportWidth(window.innerWidth);

      if (nextMode === prevViewportModeRef.current) return;
      prevViewportModeRef.current = nextMode;

      if (nextMode === 'mobile') {
        setMobileChatOpen(false);
      }
    };

    handleViewport();
    window.addEventListener('resize', handleViewport);
    return () => window.removeEventListener('resize', handleViewport);
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

  const applyChatWidth = useCallback((nextWidth: number) => {
    desktopChatWrapperRef.current?.style.setProperty('--desktop-chat-width', `${nextWidth}px`);
  }, []);

  const getChatMaxWidth = useCallback(() => {
    const containerWidth = desktopMainRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, containerWidth - MAIN_CONTENT_MIN_WIDTH));
  }, []);

  const chatResize = usePanelResize({
    orientation: 'vertical',
    direction: -1,
    value: chatWidth,
    min: CHAT_WIDTH_MIN,
    max: getChatMaxWidth,
    onResize: applyChatWidth,
    onResizeEnd: setChatWidth,
  });

  useEffect(() => {
    applyChatWidth(chatWidth);
  }, [applyChatWidth, chatWidth]);

  useEffect(() => {
    const handleKeyboardToggle = (event: KeyboardEvent) => {
      if (viewportMode !== 'desktop') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() !== 'k') return;

      event.preventDefault();
      handleDesktopChatPrimaryAction();
    };

    window.addEventListener('keydown', handleKeyboardToggle);
    return () => window.removeEventListener('keydown', handleKeyboardToggle);
  }, [handleDesktopChatPrimaryAction, viewportMode]);

  useEffect(() => {
    const handleOpenChatSession = (event: Event) => {
      const workspaceState = useWorkspaceStore.getState();
      handleOpenChatSessionEvent(event, {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        switchWorkspace: (workspaceId) => workspaceState.setActiveWorkspace(workspaceId, 'chat'),
        openSession: forceSession,
      });
      // A native custom event can arrive before Next.js observes the matching
      // pushState call, so this path intentionally supplies the session directly.
    };

    window.addEventListener(OPEN_CHAT_SESSION_EVENT, handleOpenChatSession);
    return () => {
      window.removeEventListener(OPEN_CHAT_SESSION_EVENT, handleOpenChatSession);
    };
  }, [forceSession]);

  useEffect(() => {
    if ((!shouldOpenRouteChat && forcedSessionRequestId === 0) || viewportMode === null) return;

    const handle = window.setTimeout(() => {
      if (viewportMode === 'mobile') {
        setMobileChatOpen(true);
        return;
      }

      setDesktopChatMode('side');
      setChatVisible(true);
    }, 0);

    return () => window.clearTimeout(handle);
  }, [forcedSessionRequestId, routeSessionId, shouldOpenRouteChat, viewportMode]);

  const isMobileViewport = viewportMode === 'mobile';
  const isDesktopViewport = viewportMode === 'desktop';
  const shouldUseResponsiveChatOverlay = isDesktopViewport
    && desktopChatMode === 'side'
    && viewportWidth < MAIN_CONTENT_MIN_WIDTH + chatWidth;
  const usesDesktopChatOverlay = desktopChatMode === 'fullscreen' || shouldUseResponsiveChatOverlay;
  const isDesktopChatSideVisible = isDesktopViewport && chatVisible && !usesDesktopChatOverlay;
  const availableChatMaxWidth = Math.min(
    CHAT_WIDTH_MAX,
    Math.max(CHAT_WIDTH_MIN, viewportWidth - MAIN_CONTENT_MIN_WIDTH),
  );
  const desktopChatWrapperStyle =
    !usesDesktopChatOverlay
      ? ({
        '--desktop-chat-width': `${chatWidth}px`,
        width: chatVisible ? 'var(--desktop-chat-width)' : '0px',
      } as CSSProperties)
      : undefined;
  const chatContainerWidth = usesDesktopChatOverlay ? viewportWidth : chatWidth;
  const handleNavigationIntentChange = useCallback((nextIntent: ReturnType<typeof getChatNavigationIntent>) => {
    setNavigationIntent((currentIntent) => (
      currentIntent.sessionId === nextIntent.sessionId
      && currentIntent.shouldOpenChat === nextIntent.shouldOpenChat
        ? currentIntent
        : nextIntent
    ));
  }, []);

  const chatModeControl = (
    <DropdownMenu modal={false}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center">
              <Button
                data-testid="chat-dock-toggle"
                aria-label={tCommon('aiChat')}
                variant={isMobileViewport ? (mobileChatOpen ? 'default' : 'ghost') : (chatVisible ? 'default' : 'ghost')}
                size="sm"
                className={cn(
                  'gap-2 px-2 sm:px-3',
                  isMobileViewport ? 'rounded-full' : 'rounded-l-full rounded-r-none'
                )}
                onClick={() => {
                  if (isMobileViewport) {
                    setMobileChatOpen((prev) => !prev);
                    return;
                  }
                  handleDesktopChatPrimaryAction();
                }}
              >
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">{tCommon('aiChat')}</span>
              </Button>
              {!isMobileViewport && (
                <DropdownMenuTrigger asChild>
                  <Button
                    data-testid="chat-dock-mode-menu"
                    variant={chatVisible ? 'default' : 'ghost'}
                    size="sm"
                    className={`rounded-l-none rounded-r-full border-l px-2 ${
                      chatVisible ? 'border-primary-foreground/15' : 'border-border/60'
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
  );

  return (
    <HintProvider page={hintPage} enabled={hintEnabled}>
      <Suspense fallback={null}>
        <ChatNavigationIntentObserver onChange={handleNavigationIntentChange} />
      </Suspense>
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
        <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="relative flex h-full items-center justify-between gap-3 px-4 md:px-6">
            <div className="relative z-10 min-w-0 flex items-center gap-2 sm:gap-3">
              <AppBackButton fallbackHref={backHref} preferFallback={preferBackFallback} />
              <h1 className={cn('min-w-0 truncate text-sm font-semibold sm:text-base md:text-lg', titleClassName)}>
                {title}
              </h1>
            </div>

            {headerCenter ? (
              <div className="pointer-events-none absolute left-1/2 top-1/2 z-0 hidden -translate-x-1/2 -translate-y-1/2 xl:flex">
                <div className="pointer-events-auto">{headerCenter}</div>
              </div>
            ) : null}

            <div className="relative z-10 ml-auto flex min-w-0 items-center gap-1.5 md:gap-3">
              {headerActions}
              <NotificationBell />
              <AppLauncher />
              {chatModeControl}
              <ThemeToggle />
            </div>
          </div>
        </header>

        {headerBelow}

        {viewportMode === null ? (
          <main className="min-h-0 flex-1 overflow-hidden bg-background" />
        ) : (
          <main ref={desktopMainRef} className="relative flex min-h-0 flex-1 overflow-hidden">
            <div className={cn('min-w-0 flex-1 overflow-y-auto', mainClassName)}>{children}</div>

            {isDesktopChatSideVisible ? (
              <ResizeHandle
                data-testid="chat-dock-resize-handle"
                orientation="vertical"
                label={tChat('resizeHandleLabel')}
                controls="chat-dock-desktop"
                min={CHAT_WIDTH_MIN}
                max={availableChatMaxWidth}
                value={chatWidth}
                resizing={chatResize.isResizing}
                {...chatResize.handleProps}
              />
            ) : null}

            {isDesktopViewport ? (
              <div
                ref={desktopChatWrapperRef}
                id="chat-dock-desktop"
                data-testid="chat-dock-desktop"
                data-chat-visible={chatVisible ? 'true' : 'false'}
                data-chat-mode={shouldUseResponsiveChatOverlay ? 'responsive-overlay' : desktopChatMode}
                style={desktopChatWrapperStyle}
                className={cn(
                  usesDesktopChatOverlay
                    ? 'absolute inset-0 z-[70] overflow-hidden bg-background shadow-[0_0_0_1px_hsl(var(--border)),0_24px_60px_-24px_hsl(var(--foreground)/0.45)] transition-[opacity,box-shadow] duration-200 ease-out motion-reduce:transition-none'
                    : cn(
                      'relative flex-shrink-0 overflow-hidden bg-background',
                      chatResize.isResizing
                        ? 'transition-none'
                        : 'transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none',
                    ),
                  chatVisible
                    ? 'opacity-100'
                    : usesDesktopChatOverlay
                      ? 'pointer-events-none opacity-0'
                      : 'pointer-events-none w-0 opacity-0',
                )}
              >
                <div className="flex h-full w-full flex-col">
                  <CanvasAgentChat
                    hideNavHeader
                    forcedSessionId={forcedChatSessionId}
                    requestContext={requestContext}
                    chatContainerWidth={chatContainerWidth}
                    isSurfaceVisible={chatVisible}
                  />
                </div>
              </div>
            ) : null}

            <Sheet open={mobileChatOpen} onOpenChange={setMobileChatOpen}>
              <SheetContent
                data-testid="chat-dock-mobile-sheet"
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
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <CanvasAgentChat
                    hideNavHeader
                    forcedSessionId={forcedChatSessionId}
                    requestContext={requestContext}
                    chatContainerWidth={chatWidth}
                    isSurfaceVisible={mobileChatOpen}
                  />
                </div>
              </SheetContent>
            </Sheet>
          </main>
        )}
      </div>
    </HintProvider>
  );
}
