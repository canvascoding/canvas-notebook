'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ChevronDown, Maximize2, MessageSquare, PanelRight, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/i18n/navigation';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { HelpDropdown } from '@/app/components/onboarding/HelpDropdown';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
import { LogoutButton } from '@/app/components/LogoutButton';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { useStudioChatContext } from '@/app/apps/studio/context/studio-chat-context';
import type { ChatRequestContext } from '@/app/lib/chat/types';
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

type DesktopChatMode = 'side' | 'fullscreen';

const CHAT_WIDTH_MIN = 300;
const CHAT_WIDTH_MAX = 600;
const DEFAULT_CHAT_WIDTH = 420;

function getStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === 'undefined') return fallback;
  const stored = window.localStorage.getItem(key);
  return stored === null ? fallback : stored === 'true';
}

function getStoredChatWidth() {
  if (typeof window === 'undefined') return DEFAULT_CHAT_WIDTH;
  const stored = Number(window.localStorage.getItem('studio.chatWidth'));
  if (!Number.isFinite(stored)) return DEFAULT_CHAT_WIDTH;
  return Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, stored));
}

function getBackHref(pathname: string | null) {
  if (pathname?.match(/^\/studio\/models\/[^/]+$/)) {
    return '/studio/models';
  }
  if (pathname?.match(/^\/studio\/presets\/[^/]+$/)) {
    return '/studio/presets';
  }
  if (pathname?.match(/^\/studio\/products\/[^/]+$/)) {
    return '/studio/products';
  }
  if (pathname?.match(/^\/studio\/personas\/[^/]+$/)) {
    return '/studio/personas';
  }
  if (pathname?.startsWith('/studio/')) {
    return '/studio';
  }
  return '/';
}

function getStudioTitle(pathname: string | null, tStudio: ReturnType<typeof useTranslations>) {
  if (pathname?.startsWith('/studio/create')) return tStudio('tabs.create');
  if (pathname?.startsWith('/studio/bulk')) return tStudio('tabs.bulk');
  if (pathname?.startsWith('/studio/models')) return tStudio('tabs.models');
  if (pathname?.startsWith('/studio/presets')) return tStudio('tabs.presets');
  return tStudio('title');
}

export function StudioShell({ children }: { children: ReactNode }) {
  const tCommon = useTranslations('common');
  const tNav = useTranslations('navigation');
  const tChat = useTranslations('chat');
  const tStudio = useTranslations('studio');
  const pathname = usePathname();
  const { chatContext } = useStudioChatContext();
  const [viewportMode, setViewportMode] = useState<'mobile' | 'desktop' | null>(null);
  const [chatVisible, setChatVisible] = useState(() => getStoredBoolean('studio.chatVisible', true));
  const [chatWidth, setChatWidth] = useState(getStoredChatWidth);
  const [desktopChatMode, setDesktopChatMode] = useState<DesktopChatMode>('side');
  const [mobileChatOpen, setMobileChatOpen] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(DEFAULT_CHAT_WIDTH);
  const isResizing = useRef(false);
  const prevViewportModeRef = useRef<'mobile' | 'desktop' | null>(null);

  const backHref = getBackHref(pathname);
  const title = getStudioTitle(pathname, tStudio);
  const backLabel = pathname?.startsWith('/studio/') ? tStudio('title') : tCommon('suite');
  const requestContext = useMemo<ChatRequestContext>(
    () => (chatContext?.currentPage === pathname ? chatContext : { currentPage: pathname ?? '/studio' }),
    [chatContext, pathname]
  );

  useEffect(() => {
    window.localStorage.setItem('studio.chatVisible', String(chatVisible));
  }, [chatVisible]);

  useEffect(() => {
    window.localStorage.setItem('studio.chatWidth', String(chatWidth));
  }, [chatWidth]);

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

  const handleMouseMove = useCallback((event: MouseEvent) => {
    if (!isResizing.current) return;
    const newWidth = window.innerWidth - event.clientX;
    setChatWidth(Math.min(CHAT_WIDTH_MAX, Math.max(CHAT_WIDTH_MIN, newWidth)));
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  const startResizing = useCallback(() => {
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const handleMouseUp = () => {
      if (isResizing.current) {
        stopResizing();
      }
    };

    const handleGlobalMouseMove = (event: MouseEvent) => {
      if (isResizing.current) {
        handleMouseMove(event);
      }
    };

    document.addEventListener('mousemove', handleGlobalMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleGlobalMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, stopResizing]);

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

  const isMobileViewport = viewportMode === 'mobile';
  const isDesktopViewport = viewportMode === 'desktop';
  const isDesktopChatSideVisible = isDesktopViewport && chatVisible && desktopChatMode === 'side';
  const isDesktopChatFullscreen = isDesktopViewport && chatVisible && desktopChatMode === 'fullscreen';
  const desktopChatWrapperStyle =
    desktopChatMode === 'side'
      ? ({ width: chatVisible ? `${chatWidth}px` : '0px' } as CSSProperties)
      : undefined;
  const chatContainerWidth = isDesktopChatFullscreen ? viewportWidth : chatWidth;

  const chatModeControl = (
    <DropdownMenu modal={false}>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center">
              <Button
                variant={isMobileViewport ? (mobileChatOpen ? 'default' : 'ghost') : (chatVisible ? 'default' : 'ghost')}
                size="sm"
                className="gap-2 rounded-l-full rounded-r-none px-2 sm:px-3"
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
              <DropdownMenuTrigger asChild>
                <Button
                  variant={isMobileViewport ? (mobileChatOpen ? 'default' : 'ghost') : (chatVisible ? 'default' : 'ghost')}
                  size="sm"
                  className={`rounded-l-none rounded-r-full border-l px-2 ${
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
  );

  return (
    <HintProvider page="studio">
      <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
        <header className="z-40 h-16 flex-shrink-0 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85">
          <div className="flex h-full items-center justify-between gap-3 px-4 md:px-6">
            <div className="min-w-0 flex items-center gap-2 sm:gap-3">
              <Button asChild variant="outline" size="sm" className="gap-2 px-2 sm:px-3">
                <Link href={backHref}>
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">{backLabel}</span>
                </Link>
              </Button>
              <h1 className="min-w-0 truncate text-sm font-semibold sm:text-base md:text-lg">{title}</h1>
            </div>

            <div className="ml-auto flex min-w-0 items-center gap-1.5 md:gap-3">
              {chatModeControl}
              <HelpDropdown page="studio" />
              <ThemeToggle />
              <LogoutButton />
            </div>
          </div>
        </header>

        {viewportMode === null ? (
          <main className="min-h-0 flex-1 overflow-hidden bg-background" />
        ) : (
          <main className="relative flex min-h-0 flex-1 overflow-hidden">
            <div className="min-w-0 flex-1 overflow-y-auto">{children}</div>

            {isDesktopChatSideVisible ? (
              <div
                aria-label="Resize studio chat"
                onMouseDown={startResizing}
                className="hidden w-1 cursor-col-resize items-center justify-center bg-border transition-all hover:w-1.5 hover:bg-primary/60 md:flex"
              >
                <div className="h-8 w-0.5 bg-muted-foreground/60" />
              </div>
            ) : null}

            {isDesktopViewport ? (
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
                <div className="flex h-full w-full flex-col">
                  <CanvasAgentChat
                    hideNavHeader
                    requestContext={requestContext}
                    chatContainerWidth={chatContainerWidth}
                    isSurfaceVisible={chatVisible}
                  />
                </div>
              </div>
            ) : null}

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
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  <CanvasAgentChat
                    hideNavHeader
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
