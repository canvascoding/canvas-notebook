"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Files,
  FileText,
  Globe2,
  Mail,
  MessageSquare,
  PanelRight,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { SidebarProvider } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { EmailClient } from '@/app/apps/email/components/EmailClient';
import { useEmailChatContext } from '@/app/apps/email/context/email-chat-context';
import { AppLauncher } from '@/app/components/AppLauncher';
import { BrowserLabClient } from '@/app/components/browser-lab/BrowserLabClient';
import CanvasAgentChat from '@/app/components/canvas-agent-chat/CanvasAgentChat';
import { FileEditor } from '@/app/components/editor/FileEditor';
import { FileBrowser } from '@/app/components/file-browser/FileBrowser';
import { AppLayout } from '@/app/components/layout/AppLayout';
import { ResizeHandle, usePanelResize } from '@/app/components/layout/ResizeHandle';
import { NotificationBell } from '@/app/components/notifications/NotificationBell';
import { HintProvider } from '@/app/components/onboarding/HintProvider';
import { TerminalPanel } from '@/app/components/terminal/Terminal';
import { ThemeToggle } from '@/app/components/ThemeToggle';
import { useNotebookLayoutController } from '@/app/components/notebook/useNotebookLayoutController';
import { useNotebookToolContext } from '@/app/components/notebook/useNotebookToolContext';
import {
  WorkspaceSwitcher,
  useShouldShowWorkspaceSwitcher,
} from '@/app/components/workspaces/WorkspaceSwitcher';
import { FileWatcherProvider } from '@/app/hooks/FileWatcherContext';
import { CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY } from '@/app/lib/chat/constants';
import {
  getNotebookNavigationIntent,
} from '@/app/lib/chat/chat-navigation-intent';
import {
  clearPendingNotebookFileReference,
  NOTEBOOK_WINDOW_NAME,
  parseNotebookFileReferenceRequest,
  readPendingNotebookFileReference,
  type NotebookFileReferenceRequest,
} from '@/app/lib/chat/notebook-file-reference-bridge';
import {
  handleOpenChatSessionEvent,
  OPEN_CHAT_SESSION_EVENT,
} from '@/app/lib/chat/open-chat-session-event';
import type { ChatRequestContext } from '@/app/lib/chat/types';
import {
  clearLegacyStoredNotebookOpenFilePath,
  clearStoredNotebookOpenFilePath,
  normalizeNotebookFilePath,
  readStoredNotebookOpenFilePath,
  writeStoredNotebookOpenFilePath,
} from '@/app/lib/files/notebook-open-file-storage';
import { createWorkspaceFileTransitionId } from '@/app/lib/files/open-transition';
import {
  notifyWorkspaceFileOpened,
  WORKSPACE_FILE_OPENED_EVENT,
} from '@/app/lib/files/workspace-file-events';
import { requestWorkspaceMarkdownLocation } from '@/app/lib/markdown/workspace-markdown-navigation';
import {
  NOTEBOOK_CHAT_MAX_WIDTH,
  NOTEBOOK_CHAT_MIN_WIDTH,
  NOTEBOOK_DOCUMENT_MIN_WIDTH,
  NOTEBOOK_EXPLORER_MAX_WIDTH,
  NOTEBOOK_EXPLORER_MIN_WIDTH,
  type NotebookContextSurface,
  type NotebookMainSurface,
} from '@/app/lib/notebook/layout-state';
import { useEditorStore } from '@/app/store/editor-store';
import { useFileStore } from '@/app/store/file-store';
import {
  useWorkspaceStore,
  WORKSPACE_CHANGED_EVENT,
  type WorkspaceChangedDetail,
} from '@/app/store/workspace-store';
import { useForcedChatSession } from '@/app/components/canvas-agent-chat/useForcedChatSession';

type SurfaceTabProps = {
  active: boolean;
  closeLabel?: string;
  icon: ReactNode;
  label: string;
  onClose?: () => void;
  onSelect: () => void;
  testId: string;
};

function SurfaceTab({
  active,
  closeLabel,
  icon,
  label,
  onClose,
  onSelect,
  testId,
}: SurfaceTabProps) {
  return (
    <div
      className={cn(
        'group/tab flex h-8 shrink-0 items-center overflow-hidden rounded-md border transition-colors',
        active
          ? 'border-primary/35 bg-primary/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]'
          : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        data-testid={testId}
        className="flex h-full min-w-0 items-center gap-2 px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onSelect}
      >
        {icon}
        <span className="max-w-36 truncate sm:max-w-52">{label}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function SurfaceLayer({
  active,
  children,
  testId,
}: {
  active: boolean;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section
      data-testid={testId}
      aria-hidden={!active}
      className={cn(
        'absolute inset-0 min-h-0 min-w-0 overflow-hidden bg-background',
        active ? 'visible z-10' : 'invisible z-0 pointer-events-none',
      )}
    >
      {children}
    </section>
  );
}

function BrowserContextHeader({
  action,
  status,
  url,
}: {
  action?: string;
  status: 'running' | 'complete';
  url?: string;
}) {
  const t = useTranslations('notebook');
  return (
    <div className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/25 px-3 py-2 text-xs">
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          status === 'running' ? 'animate-pulse bg-amber-500' : 'bg-emerald-500',
        )} />
        <span className="font-medium text-foreground">
          {status === 'running' ? t('contextToolRunning') : t('contextToolComplete')}
        </span>
        {action ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">{action}</span> : null}
      </div>
      {url ? <span className="min-w-0 truncate font-mono text-muted-foreground">{url}</span> : null}
    </div>
  );
}

function NotebookEmptyDocumentState({ onOpenExplorer, onOpenChat }: {
  onOpenExplorer: () => void;
  onOpenChat: () => void;
}) {
  const t = useTranslations('notebook');
  return (
    <div className="flex h-full items-center justify-center overflow-auto bg-[radial-gradient(circle_at_top_left,hsl(var(--primary)/0.08),transparent_42%),hsl(var(--background))] p-6">
      <div className="w-full max-w-md border border-border/80 bg-card/95 p-6 shadow-[0_28px_80px_-48px_hsl(var(--foreground)/0.55)]">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-border bg-muted text-primary">
          <FileText className="h-5 w-5" />
        </div>
        <h2 className="mt-5 text-xl font-semibold tracking-tight">{t('emptyStateTitle')}</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('emptyStateDescription')}</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={onOpenExplorer}>
            <Files className="mr-2 h-4 w-4" />
            {t('selectFile')}
          </Button>
          <Button variant="outline" onClick={onOpenChat}>
            <MessageSquare className="mr-2 h-4 w-4" />
            {t('openChat')}
          </Button>
        </div>
      </div>
    </div>
  );
}

function clearStoredNotebookOpenFilePathIfMatches(path: string, workspaceId: string | null) {
  if (!workspaceId || typeof window === 'undefined') return;
  try {
    if (readStoredNotebookOpenFilePath(window.localStorage, workspaceId) === path) {
      clearStoredNotebookOpenFilePath(window.localStorage, workspaceId);
    }
  } catch {
    // Local UI persistence is non-critical.
  }
}

export function DashboardShell({ hintEnabled = true }: { hintEnabled?: boolean }) {
  const tNotebook = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('navigation');
  const searchParams = useSearchParams();
  const layout = useNotebookLayoutController();
  const { state, dispatch } = layout;
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [activeChatContext, setActiveChatContext] = useState<{
    agentId: string;
    sessionId: string;
  } | null>(null);
  const desktopExplorerRef = useRef<HTMLDivElement | null>(null);
  const desktopMainPanelRef = useRef<HTMLDivElement | null>(null);
  const desktopChatRef = useRef<HTMLDivElement | null>(null);
  const openedPathRef = useRef<string | null>(null);
  const initialNotebookStateResolvedRef = useRef(false);
  const previousCurrentFileIdentityRef = useRef<string | null>(null);

  const currentFile = useFileStore((fileState) => fileState.currentFile);
  const isLoadingFile = useFileStore((fileState) => fileState.isLoadingFile);
  const fileError = useFileStore((fileState) => fileState.fileError);
  const currentDirectory = useFileStore((fileState) => fileState.currentDirectory);
  const activeWorkspaceId = useWorkspaceStore((workspaceState) => workspaceState.activeWorkspaceId);
  const showWorkspaceSwitcher = useShouldShowWorkspaceSwitcher();
  const { chatContext: emailChatContext } = useEmailChatContext();

  const navigationIntent = getNotebookNavigationIntent(searchParams);
  const routeFilePath = navigationIntent.path;
  const routeSessionId = navigationIntent.sessionId;
  const shouldOpenRouteChat = navigationIntent.shouldOpenChat;
  const {
    forceSession: applyForcedChatSession,
    forcedSessionId,
    requestId: chatOpenRequestId,
  } = useForcedChatSession(routeSessionId);
  const hasStoredInitialPrompt =
    typeof window !== 'undefined'
    && Boolean(window.sessionStorage.getItem(CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY));
  const shouldForceChatOpen = shouldOpenRouteChat || hasStoredInitialPrompt;

  const handleContextOpen = useCallback((surface: NotebookContextSurface) => {
    dispatch({ type: 'CONTEXT_OPENED', surface });
  }, [dispatch]);
  const {
    emailContext,
    browserContext,
    clearEmail,
    clearBrowser,
  } = useNotebookToolContext({
    chatContext: activeChatContext,
    onOpen: handleContextOpen,
  });

  const requestContext = useMemo<ChatRequestContext>(() => {
    if (state.mainSurface === 'email' && emailChatContext) {
      return emailChatContext;
    }
    if (state.mainSurface === 'browser') {
      return { currentPage: '/browser/live' };
    }
    return { currentPage: '/notebook' };
  }, [emailChatContext, state.mainSurface]);

  const currentDirectoryLabel =
    currentDirectory === '.' ? tNotebook('workspaceRoot') : `/${currentDirectory}`;
  const fileLabel = currentFile?.path.split('/').filter(Boolean).pop()
    || useFileStore.getState().loadingFilePath?.split('/').filter(Boolean).pop()
    || tNotebook('documentSurface');

  const openNotebookFile = useCallback(async (path: string) => {
    const normalizedPath = normalizeNotebookFilePath(path);
    if (!normalizedPath) return null;

    dispatch({ type: 'DOCUMENT_OPENED' });
    const transitionId = createWorkspaceFileTransitionId();
    const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    const result = await useFileStore.getState().revealAndLoadFile(normalizedPath, {
      transitionId,
      workspaceId,
    });
    if (result.status !== 'opened') {
      if (result.status !== 'superseded') {
        clearStoredNotebookOpenFilePathIfMatches(normalizedPath, workspaceId);
      }
      return result;
    }

    const loadedPath = useFileStore.getState().currentFile?.path ?? null;
    if (loadedPath === normalizedPath && workspaceId) {
      try {
        writeStoredNotebookOpenFilePath(window.localStorage, workspaceId, normalizedPath);
      } catch {
        // Local UI persistence is non-critical.
      }
    }
    return result;
  }, [dispatch]);

  const openBridgedNotebookFile = useCallback(async (request: NotebookFileReferenceRequest) => {
    openedPathRef.current = request.path;
    const result = await openNotebookFile(request.path);
    if (result?.status !== 'opened') {
      if (openedPathRef.current === request.path) openedPathRef.current = null;
      return;
    }

    clearPendingNotebookFileReference(request.requestId);
    notifyWorkspaceFileOpened(request.path, 'chat-reference');
    if (request.blockId || request.heading) {
      requestWorkspaceMarkdownLocation({
        path: request.path,
        blockId: request.blockId,
        heading: request.heading,
      });
    }
  }, [openNotebookFile]);

  useEffect(() => {
    const pendingBridgeRequest = window.name === NOTEBOOK_WINDOW_NAME
      ? readPendingNotebookFileReference()
      : null;
    if (!pendingBridgeRequest && routeFilePath && openedPathRef.current !== routeFilePath) {
      openedPathRef.current = routeFilePath;
      void openNotebookFile(routeFilePath);
    }
    if (shouldOpenRouteChat) {
      dispatch({ type: 'SHOW_CHAT' });
    }
  }, [dispatch, openNotebookFile, routeFilePath, shouldOpenRouteChat]);

  useEffect(() => {
    if (window.name !== NOTEBOOK_WINDOW_NAME) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const request = parseNotebookFileReferenceRequest(event.data);
      if (request) void openBridgedNotebookFile(request);
    };
    window.addEventListener('message', handleMessage);
    const pendingRequest = readPendingNotebookFileReference();
    if (pendingRequest) queueMicrotask(() => void openBridgedNotebookFile(pendingRequest));
    return () => window.removeEventListener('message', handleMessage);
  }, [openBridgedNotebookFile]);

  useEffect(() => {
    const handleOpenChatSession = (event: Event) => {
      const workspaceState = useWorkspaceStore.getState();
      handleOpenChatSessionEvent(event, {
        activeWorkspaceId: workspaceState.activeWorkspaceId,
        switchWorkspace: (workspaceId) => workspaceState.setActiveWorkspace(workspaceId, 'chat'),
        openSession: applyForcedChatSession,
      });
      dispatch({ type: 'SHOW_CHAT' });
    };
    window.addEventListener(OPEN_CHAT_SESSION_EVENT, handleOpenChatSession);
    return () => window.removeEventListener(OPEN_CHAT_SESSION_EVENT, handleOpenChatSession);
  }, [applyForcedChatSession, dispatch]);

  useEffect(() => {
    if (!forcedSessionId || chatOpenRequestId === 0) return;
    dispatch({ type: 'SHOW_CHAT' });
  }, [chatOpenRequestId, dispatch, forcedSessionId]);

  useEffect(() => {
    if (
      !layout.preferencesHydrated
      || layout.viewportWidth === 0
      || !activeWorkspaceId
      || initialNotebookStateResolvedRef.current
    ) {
      return;
    }
    initialNotebookStateResolvedRef.current = true;
    if (routeFilePath) {
      if (shouldForceChatOpen) dispatch({ type: 'SHOW_CHAT' });
      return;
    }

    let storedPath: string | null = null;
    try {
      clearLegacyStoredNotebookOpenFilePath(window.localStorage);
      storedPath = readStoredNotebookOpenFilePath(window.localStorage, activeWorkspaceId);
    } catch {
      // Start with chat if local persistence is unavailable.
    }
    if (storedPath) {
      openedPathRef.current = storedPath;
      void openNotebookFile(storedPath);
      if (shouldForceChatOpen) dispatch({ type: 'SHOW_CHAT' });
      return;
    }

    useFileStore.getState().clearCurrentFile();
    dispatch({ type: 'DOCUMENT_CLOSED' });
    dispatch({ type: 'SHOW_CHAT' });
  }, [
    activeWorkspaceId,
    dispatch,
    layout.preferencesHydrated,
    layout.viewportWidth,
    openNotebookFile,
    routeFilePath,
    shouldForceChatOpen,
  ]);

  useEffect(() => {
    const initialFileState = useFileStore.getState();
    previousCurrentFileIdentityRef.current =
      initialFileState.currentFile && initialFileState.currentFileWorkspaceId
        ? `${initialFileState.currentFileWorkspaceId}\0${initialFileState.currentFile.path}`
        : null;

    return useFileStore.subscribe((fileState) => {
      const nextPath = fileState.currentFile?.path ?? null;
      const workspaceId = fileState.currentFileWorkspaceId;
      const nextIdentity = nextPath && workspaceId ? `${workspaceId}\0${nextPath}` : null;
      const previousIdentity = previousCurrentFileIdentityRef.current;
      previousCurrentFileIdentityRef.current = nextIdentity;
      if (!nextPath || !workspaceId || nextIdentity === previousIdentity) return;
      try {
        writeStoredNotebookOpenFilePath(window.localStorage, workspaceId, nextPath);
      } catch {
        // Local UI persistence is non-critical.
      }
    });
  }, []);

  useEffect(() => {
    const handleWorkspaceChange = (event: Event) => {
      const { activeWorkspaceId: nextWorkspaceId } =
        (event as CustomEvent<WorkspaceChangedDetail>).detail;
      openedPathRef.current = routeFilePath;
      previousCurrentFileIdentityRef.current = null;
      useFileStore.getState().resetWorkspaceView(nextWorkspaceId);
      useEditorStore.getState().clear();
      clearEmail();
      clearBrowser();
      dispatch({ type: 'DOCUMENT_CLOSED' });
      dispatch({ type: 'CONTEXT_CLOSED', surface: 'email' });
      dispatch({ type: 'CONTEXT_CLOSED', surface: 'browser' });

      if (routeFilePath) return;
      let storedPath: string | null = null;
      try {
        storedPath = readStoredNotebookOpenFilePath(window.localStorage, nextWorkspaceId);
      } catch {
        // Keep chat as the deterministic fallback.
      }
      if (!storedPath) {
        dispatch({ type: 'SHOW_CHAT' });
        return;
      }
      openedPathRef.current = storedPath;
      window.setTimeout(() => {
        if (useWorkspaceStore.getState().activeWorkspaceId === nextWorkspaceId) {
          void openNotebookFile(storedPath);
        }
      }, 0);
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
  }, [clearBrowser, clearEmail, dispatch, openNotebookFile, routeFilePath]);

  useEffect(() => {
    const handleWorkspaceFileOpen = () => {
      dispatch({ type: 'DOCUMENT_OPENED' });
      setMobileExplorerOpen(false);
    };
    window.addEventListener(WORKSPACE_FILE_OPENED_EVENT, handleWorkspaceFileOpen);
    return () => window.removeEventListener(WORKSPACE_FILE_OPENED_EVENT, handleWorkspaceFileOpen);
  }, [dispatch]);

  const handleCloseDocument = useCallback(() => {
    useFileStore.getState().clearCurrentFile();
    if (activeWorkspaceId) {
      try {
        clearStoredNotebookOpenFilePath(window.localStorage, activeWorkspaceId);
      } catch {
        // Local UI persistence is non-critical.
      }
    }
    dispatch({ type: 'DOCUMENT_CLOSED' });
  }, [activeWorkspaceId, dispatch]);

  const handleCloseContext = useCallback((surface: NotebookContextSurface) => {
    if (surface === 'email') clearEmail();
    else clearBrowser();
    dispatch({ type: 'CONTEXT_CLOSED', surface });
  }, [clearBrowser, clearEmail, dispatch]);

  useEffect(() => {
    const handleDesktopSidebarToggle = () => {
      if (!layout.isDesktop) return;
      dispatch({ type: 'SET_EXPLORER', open: !state.explorerOpen });
    };
    const handleDesktopChatToggle = () => dispatch({ type: 'SHOW_CHAT' });
    window.addEventListener('notebook-desktop-toggle-sidebar', handleDesktopSidebarToggle);
    window.addEventListener('notebook-desktop-toggle-chat', handleDesktopChatToggle);
    return () => {
      window.removeEventListener('notebook-desktop-toggle-sidebar', handleDesktopSidebarToggle);
      window.removeEventListener('notebook-desktop-toggle-chat', handleDesktopChatToggle);
    };
  }, [dispatch, layout.isDesktop, state.explorerOpen]);

  useEffect(() => {
    const handleKeyboardToggle = (event: KeyboardEvent) => {
      if (!layout.isDesktop || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'k') {
        event.preventDefault();
        if (event.shiftKey) {
          dispatch({ type: 'SET_CHAT_DOCKED', docked: !state.chatDocked });
        } else {
          dispatch({ type: 'SHOW_CHAT' });
        }
      } else if (key === 'j') {
        event.preventDefault();
        dispatch({ type: 'SET_TERMINAL', open: !state.terminalOpen });
      } else if (key === 'b') {
        event.preventDefault();
        dispatch({ type: 'SET_EXPLORER', open: !state.explorerOpen });
      }
    };
    window.addEventListener('keydown', handleKeyboardToggle);
    return () => window.removeEventListener('keydown', handleKeyboardToggle);
  }, [
    dispatch,
    layout.isDesktop,
    state.chatDocked,
    state.explorerOpen,
    state.terminalOpen,
  ]);

  const applyExplorerWidth = useCallback((width: number) => {
    desktopExplorerRef.current?.style.setProperty('--notebook-explorer-width', `${width}px`);
  }, []);
  const applyChatWidth = useCallback((width: number) => {
    desktopChatRef.current?.style.setProperty('--notebook-chat-width', `${width}px`);
  }, []);
  const explorerMaxWidth = useCallback(() => Math.min(
    NOTEBOOK_EXPLORER_MAX_WIDTH,
    Math.max(
      NOTEBOOK_EXPLORER_MIN_WIDTH,
      layout.viewportWidth
        - NOTEBOOK_DOCUMENT_MIN_WIDTH
        - (state.chatDocked ? layout.chatWidth : 0),
    ),
  ), [layout.chatWidth, layout.viewportWidth, state.chatDocked]);
  const chatMaxWidth = useCallback(() => {
    const containerWidth =
      desktopMainPanelRef.current?.getBoundingClientRect().width ?? layout.viewportWidth;
    return Math.min(
      NOTEBOOK_CHAT_MAX_WIDTH,
      Math.max(NOTEBOOK_CHAT_MIN_WIDTH, containerWidth - NOTEBOOK_DOCUMENT_MIN_WIDTH),
    );
  }, [layout.viewportWidth]);
  const explorerResize = usePanelResize({
    orientation: 'vertical',
    value: layout.explorerWidth,
    min: NOTEBOOK_EXPLORER_MIN_WIDTH,
    max: explorerMaxWidth,
    onResize: applyExplorerWidth,
    onResizeEnd: layout.setExplorerWidth,
  });
  const chatResize = usePanelResize({
    orientation: 'vertical',
    direction: -1,
    value: layout.chatWidth,
    min: NOTEBOOK_CHAT_MIN_WIDTH,
    max: chatMaxWidth,
    onResize: applyChatWidth,
    onResizeEnd: layout.setChatWidth,
  });
  useEffect(() => applyExplorerWidth(layout.explorerWidth), [applyExplorerWidth, layout.explorerWidth]);
  useEffect(() => applyChatWidth(layout.chatWidth), [applyChatWidth, layout.chatWidth]);
  const availableChatMaxWidth = Math.min(
    NOTEBOOK_CHAT_MAX_WIDTH,
    Math.max(
      NOTEBOOK_CHAT_MIN_WIDTH,
      layout.viewportWidth
        - (state.explorerOpen ? layout.explorerWidth : 0)
        - NOTEBOOK_DOCUMENT_MIN_WIDTH,
    ),
  );

  const showChat = useCallback(() => dispatch({ type: 'SHOW_CHAT' }), [dispatch]);
  const showSurface = useCallback((surface: Exclude<NotebookMainSurface, 'chat'>) => {
    dispatch({ type: 'SHOW_SURFACE', surface });
  }, [dispatch]);
  const handleFileSelected = useCallback(() => {
    dispatch({ type: 'DOCUMENT_OPENED' });
    setMobileExplorerOpen(false);
  }, [dispatch]);

  const chatVisible = state.mainSurface === 'chat' || state.chatDocked;
  const browserLocale = typeof document !== 'undefined'
    ? document.documentElement.lang || 'de'
    : 'de';
  const chatContent = (
    <CanvasAgentChat
      initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
      hideNavHeader
      forcedSessionId={forcedSessionId}
      requestContext={requestContext}
      isSurfaceVisible={chatVisible}
      onSessionContextChange={setActiveChatContext}
    />
  );
  const documentContent = currentFile || isLoadingFile || fileError
    ? <FileEditor onClosePreview={handleCloseDocument} />
    : (
      <NotebookEmptyDocumentState
        onOpenExplorer={() => layout.isMobile
          ? setMobileExplorerOpen(true)
          : dispatch({ type: 'SET_EXPLORER', open: true })}
        onOpenChat={showChat}
      />
    );

  const contextStatus = (surface: NotebookContextSurface) => {
    const intent = surface === 'email' ? emailContext : browserContext;
    return intent?.status === 'running' ? tNotebook('contextRunning') : null;
  };

  return (
    <FileWatcherProvider>
      <HintProvider page="notebook" enabled={hintEnabled}>
        <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
          <header className="z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/88 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <Button asChild variant="outline" size="sm" className="shrink-0 gap-2 px-2 sm:px-3">
                <Link href="/">
                  <ArrowLeft className="h-4 w-4" />
                  <span className="hidden sm:inline">{tCommon('suite')}</span>
                </Link>
              </Button>
              <div className="hidden min-w-0 md:block">
                <div className="truncate text-sm font-semibold">{tNotebook('workbenchTitle')}</div>
                <div className="truncate text-[11px] text-muted-foreground">{tNotebook('workbenchSubtitle')}</div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 md:gap-3">
              <WorkspaceSwitcher source="notebook" variant="compact" className="hidden md:inline-flex" />
              <NotificationBell />
              <AppLauncher />
              <ThemeToggle />
            </div>
          </header>

          {layout.isMobile && showWorkspaceSwitcher ? (
            <div className="z-30 shrink-0 border-b border-border bg-background/95 px-3 py-2 md:hidden">
              <WorkspaceSwitcher source="notebook" variant="mobile-sheet" />
            </div>
          ) : null}

          <div className="z-30 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-2">
            <TooltipProvider delayDuration={250}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant={(layout.isMobile ? mobileExplorerOpen : state.explorerOpen) ? 'secondary' : 'ghost'}
                    size="icon-sm"
                    className="shrink-0"
                    aria-label={layout.isMobile
                      ? tNav('openFileExplorer')
                      : state.explorerOpen ? tNav('hideSidebar') : tNav('showSidebar')}
                    aria-pressed={layout.isMobile ? mobileExplorerOpen : state.explorerOpen}
                    onClick={() => {
                      if (layout.isMobile) {
                        setMobileExplorerOpen(true);
                      } else {
                        dispatch({ type: 'SET_EXPLORER', open: !state.explorerOpen });
                      }
                    }}
                  >
                    <Files className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{tCommon('explorer')} ({typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'}B)</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <div className="h-5 w-px shrink-0 bg-border" />
            <div
              role="tablist"
              aria-label={tNotebook('surfaceTabsLabel')}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <SurfaceTab
                active={state.mainSurface === 'chat'}
                icon={<MessageSquare className="h-3.5 w-3.5 shrink-0" />}
                label={tCommon('aiChat')}
                onSelect={showChat}
                testId="notebook-surface-chat"
              />
              {state.documentAvailable ? (
                <SurfaceTab
                  active={state.mainSurface === 'document'}
                  icon={<FileText className="h-3.5 w-3.5 shrink-0" />}
                  label={fileLabel}
                  onSelect={() => showSurface('document')}
                  testId="notebook-surface-document"
                />
              ) : null}
              {state.emailAvailable ? (
                <SurfaceTab
                  active={state.mainSurface === 'email'}
                  closeLabel={tNotebook('closeEmailSurface')}
                  icon={<Mail className="h-3.5 w-3.5 shrink-0" />}
                  label={contextStatus('email') || tNotebook('emailSurface')}
                  onClose={() => handleCloseContext('email')}
                  onSelect={() => showSurface('email')}
                  testId="notebook-surface-email"
                />
              ) : null}
              {state.browserAvailable ? (
                <SurfaceTab
                  active={state.mainSurface === 'browser'}
                  closeLabel={tNotebook('closeBrowserSurface')}
                  icon={<Globe2 className="h-3.5 w-3.5 shrink-0" />}
                  label={contextStatus('browser') || tNotebook('browserSurface')}
                  onClose={() => handleCloseContext('browser')}
                  onSelect={() => showSurface('browser')}
                  testId="notebook-surface-browser"
                />
              ) : null}
            </div>

            {layout.isDesktop ? (
              <>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant={state.chatDocked ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        className="shrink-0"
                        disabled={!layout.canDockChat && !state.chatDocked}
                        aria-label={state.chatDocked ? tNotebook('unpinChat') : tNotebook('pinChat')}
                        aria-pressed={state.chatDocked}
                        onClick={() => dispatch({
                          type: 'SET_CHAT_DOCKED',
                          docked: !state.chatDocked,
                        })}
                      >
                        <PanelRight className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {state.chatDocked ? tNotebook('unpinChat') : tNotebook('pinChat')} ({typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'}⇧K)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant={state.terminalOpen ? 'secondary' : 'ghost'}
                        size="icon-sm"
                        className="shrink-0"
                        aria-label={state.terminalOpen ? tNotebook('hideTerminal') : tNotebook('showTerminal')}
                        aria-pressed={state.terminalOpen}
                        onClick={() => dispatch({
                          type: 'SET_TERMINAL',
                          open: !state.terminalOpen,
                        })}
                      >
                        <SquareTerminal className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {state.terminalOpen ? tNotebook('hideTerminal') : tNotebook('showTerminal')} ({typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl'}J)
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            ) : null}
          </div>

          {!layout.preferencesHydrated || layout.viewportWidth === 0 ? (
            <main className="min-h-0 flex-1 bg-background" />
          ) : layout.isMobile ? (
            <main className="relative min-h-0 flex-1 overflow-hidden">
              <SurfaceLayer active={state.mainSurface === 'document'} testId="notebook-mobile-document">
                {documentContent}
              </SurfaceLayer>
              <SurfaceLayer active={state.mainSurface === 'email'} testId="notebook-mobile-email">
                {emailContext ? <EmailClient /> : null}
              </SurfaceLayer>
              <SurfaceLayer active={state.mainSurface === 'browser'} testId="notebook-mobile-browser">
                {browserContext ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <BrowserContextHeader
                      action={browserContext.action}
                      status={browserContext.status}
                      url={browserContext.url}
                    />
                    <div className="min-h-0 flex-1">
                      <BrowserLabClient
                        locale={browserLocale}
                        variant="live"
                        agentId={browserContext.agentId}
                        sessionId={browserContext.sessionId}
                      />
                    </div>
                  </div>
                ) : null}
              </SurfaceLayer>
              <SurfaceLayer active={state.mainSurface === 'chat'} testId="notebook-mobile-chat">
                {chatContent}
              </SurfaceLayer>

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
                        <SheetDescription className="truncate text-xs">{currentDirectoryLabel}</SheetDescription>
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
                      <FileBrowser variant="mobile-sheet" onFileSelect={handleFileSelected} />
                    </SidebarProvider>
                  </div>
                </SheetContent>
              </Sheet>
            </main>
          ) : (
            <main className="flex min-h-0 flex-1 overflow-hidden">
              {state.explorerOpen ? (
                <div
                  ref={desktopExplorerRef}
                  id="onboarding-notebook-fileBrowser"
                  style={{
                    '--notebook-explorer-width': `${layout.explorerWidth}px`,
                  } as CSSProperties}
                  className="relative min-w-[var(--notebook-explorer-width)] w-[var(--notebook-explorer-width)] basis-[var(--notebook-explorer-width)] shrink-0 border-r border-border bg-card"
                >
                  <SidebarProvider className="h-full min-h-0">
                    <FileBrowser onFileSelect={handleFileSelected} />
                  </SidebarProvider>
                </div>
              ) : null}
              {state.explorerOpen ? (
                <ResizeHandle
                  data-testid="notebook-explorer-resize-handle"
                  orientation="vertical"
                  label={tNotebook('resizeFileTree')}
                  controls="onboarding-notebook-fileBrowser"
                  min={NOTEBOOK_EXPLORER_MIN_WIDTH}
                  max={explorerMaxWidth()}
                  value={layout.explorerWidth}
                  resizing={explorerResize.isResizing}
                  {...explorerResize.handleProps}
                />
              ) : null}

              <div className="min-w-0 flex-1">
                <AppLayout
                  sidebar={<div />}
                  sidebarHidden
                  terminalVisible={state.terminalOpen}
                  sidebarResizeLabel={tNotebook('resizeFileTree')}
                  terminalResizeLabel={tNotebook('resizeTerminal')}
                  main={
                    <div ref={desktopMainPanelRef} className="flex h-full min-h-0 w-full overflow-hidden">
                      <div
                        id="onboarding-notebook-editor"
                        className={cn(
                          'relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background',
                          state.mainSurface === 'chat' && 'hidden',
                        )}
                      >
                        <SurfaceLayer active={state.mainSurface === 'document'} testId="notebook-desktop-document">
                          {documentContent}
                        </SurfaceLayer>
                        <SurfaceLayer active={state.mainSurface === 'email'} testId="notebook-desktop-email">
                          {emailContext ? <EmailClient /> : null}
                        </SurfaceLayer>
                        <SurfaceLayer active={state.mainSurface === 'browser'} testId="notebook-desktop-browser">
                          {browserContext ? (
                            <div className="flex h-full min-h-0 flex-col">
                              <BrowserContextHeader
                                action={browserContext.action}
                                status={browserContext.status}
                                url={browserContext.url}
                              />
                              <div className="min-h-0 flex-1">
                                <BrowserLabClient
                                  locale={browserLocale}
                                  variant="live"
                                  agentId={browserContext.agentId}
                                  sessionId={browserContext.sessionId}
                                />
                              </div>
                            </div>
                          ) : null}
                        </SurfaceLayer>
                      </div>

                      {state.chatDocked ? (
                        <ResizeHandle
                          data-testid="notebook-chat-resize-handle"
                          orientation="vertical"
                          label={tNotebook('resizeChat')}
                          controls="onboarding-notebook-chat"
                          min={NOTEBOOK_CHAT_MIN_WIDTH}
                          max={availableChatMaxWidth}
                          value={layout.chatWidth}
                          resizing={chatResize.isResizing}
                          {...chatResize.handleProps}
                        />
                      ) : null}

                      <div
                        ref={desktopChatRef}
                        id="onboarding-notebook-chat"
                        data-testid="notebook-desktop-chat"
                        data-chat-placement={state.mainSurface === 'chat' ? 'main' : state.chatDocked ? 'side' : 'hidden'}
                        style={state.chatDocked
                          ? {
                              '--notebook-chat-width': `${layout.chatWidth}px`,
                              width: 'var(--notebook-chat-width)',
                            } as CSSProperties
                          : undefined}
                        className={cn(
                          'min-h-0 overflow-hidden bg-background',
                          state.mainSurface === 'chat'
                            ? 'min-w-0 flex-1'
                            : state.chatDocked
                              ? 'w-[var(--notebook-chat-width)] shrink-0 border-l border-border'
                              : 'hidden',
                        )}
                      >
                        {chatContent}
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
