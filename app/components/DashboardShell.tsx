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
  Files,
  FileText,
  Globe2,
  Mail,
  MessageSquare,
  PanelRight,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { AppBackButton } from '@/app/components/navigation/AppBackButton';
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
import { getFileWatcherClient, type FileEvent } from '@/app/lib/file-watcher/client';
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
import type { RuntimeStatus } from '@/app/lib/chat/runtime-status';
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
  WORKSPACE_PATH_RENAMED_EVENT,
  WORKSPACE_PATHS_DELETED_EVENT,
  WORKSPACE_FILE_OPENED_EVENT,
  type WorkspacePathRenamedDetail,
  type WorkspacePathsDeletedDetail,
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
import type {
  NotebookBrowserContextIntent,
  NotebookEmailContextIntent,
} from '@/app/lib/notebook/context-surface';
import {
  NOTEBOOK_MAX_OPEN_DOCUMENTS,
  closeNotebookDocumentTabsAtPaths,
  closeNotebookDocumentTab,
  emptyNotebookDocumentTabsState,
  openNotebookDocumentTab,
  readNotebookDocumentTabs,
  renameNotebookDocumentTabs,
  writeNotebookDocumentTabs,
  type NotebookDocumentTabsState,
} from '@/app/lib/notebook/document-tabs';
import { registerNotebookDocumentOpenGuard } from '@/app/lib/notebook/document-tab-open-guard';
import { resolveNotebookChatContext } from '@/app/lib/notebook/chat-context';
import { getNotebookTabRevealDelta } from '@/app/lib/notebook/tab-strip';
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
  controlsId: string;
  icon: ReactNode;
  label: string;
  onClose?: () => void;
  onSelect: () => void;
  testId: string;
};

type OpenNotebookFileOptions = {
  dockChatIfFull?: boolean;
};

function SurfaceTab({
  active,
  closeLabel,
  controlsId,
  icon,
  label,
  onClose,
  onSelect,
  testId,
}: SurfaceTabProps) {
  return (
    <div
      title={label}
      className={cn(
        'group/tab flex h-10 shrink-0 items-center overflow-hidden rounded-md border transition-colors sm:h-8',
        active
          ? 'border-primary/35 bg-primary/10 text-foreground shadow-[inset_0_-2px_0_hsl(var(--primary))]'
          : 'border-transparent text-muted-foreground hover:border-border hover:bg-muted/70 hover:text-foreground',
      )}
    >
      <button
        id={`${testId}-tab`}
        type="button"
        role="tab"
        aria-controls={controlsId}
        aria-selected={active}
        data-testid={testId}
        className="flex h-full min-w-0 items-center gap-1 px-2 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:gap-2 sm:px-2.5"
        onClick={onSelect}
      >
        {icon}
        <span className="max-w-28 truncate sm:max-w-52">{label}</span>
      </button>
      {onClose ? (
        <button
          type="button"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:mr-1 sm:h-6 sm:w-6"
          aria-label={closeLabel}
          title={closeLabel}
          onClick={onClose}
        >
          <X className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function SurfaceLayer({
  active,
  children,
  labelledBy,
  testId,
}: {
  active: boolean;
  children: ReactNode;
  labelledBy: string;
  testId: string;
}) {
  return (
    <section
      id={testId}
      data-testid={testId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      aria-hidden={!active}
      inert={!active}
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
  activityControlsId,
  activityVisible,
  context,
  onToggleActivity,
}: {
  activityControlsId: string;
  activityVisible: boolean;
  context: NotebookBrowserContextIntent;
  onToggleActivity: () => void;
}) {
  const t = useTranslations('notebook');
  const { snapshot } = context;
  const controlLabel = snapshot.controlMode === 'user'
    ? t('browserControlUser')
    : snapshot.controlMode === 'view'
      ? t('browserControlView')
      : t('browserControlAgent');
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/25 px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          context.status === 'running' ? 'animate-pulse bg-amber-500' : 'bg-emerald-500',
        )} />
        <span className="max-w-48 truncate font-medium text-foreground">
          {snapshot.activeTitle || (
            context.status === 'running' ? t('contextToolRunning') : t('contextToolComplete')
          )}
        </span>
        {context.action ? <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-muted-foreground">{context.action}</span> : null}
        <span className="hidden text-muted-foreground sm:inline">
          {t('browserTabCount', { count: snapshot.tabCount })}
        </span>
        <span className="hidden text-muted-foreground md:inline">{controlLabel}</span>
      </div>
      <div className="flex min-w-0 shrink-0 items-center gap-2">
        {snapshot.activeUrl || context.url ? (
          <span className="hidden min-w-0 max-w-72 truncate font-mono text-muted-foreground lg:inline">
            {snapshot.activeUrl || context.url}
          </span>
        ) : null}
        <Button
          type="button"
          variant={activityVisible ? 'secondary' : 'outline'}
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5"
          aria-controls={activityControlsId}
          aria-expanded={activityVisible}
          aria-label={activityVisible ? t('hideAgentActivity') : t('showAgentActivity')}
          data-testid="browser-agent-activity-toggle"
          onClick={onToggleActivity}
        >
          <MessageSquare className="h-3.5 w-3.5" />
          <span>{t('agentActivity')}</span>
        </Button>
      </div>
    </div>
  );
}

function BrowserActivityPanelHeader({
  onClose,
}: {
  onClose: () => void;
}) {
  const t = useTranslations('notebook');
  return (
    <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border bg-background/95 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-foreground">{t('agentActivity')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('agentActivityDescription')}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="shrink-0"
        onClick={onClose}
        aria-label={t('hideAgentActivity')}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function EmailContextHeader({
  intent,
}: {
  intent: NotebookEmailContextIntent;
}) {
  const t = useTranslations('notebook');
  const toolLabels: Record<string, string> = {
    email_list_mailboxes: t('emailToolAccounts'),
    email_list_accounts: t('emailToolAccounts'),
    email_search_messages: t('emailToolSearch'),
    email_search: t('emailToolSearch'),
    email_read_message: t('emailToolRead'),
    email_read: t('emailToolRead'),
    email_list_thread_messages: t('emailToolRead'),
    email_create_outbox_draft: t('emailToolCreateDraft'),
    email_create_draft: t('emailToolCreateDraft'),
    email_update_outbox_draft: t('emailToolUpdateDraft'),
    email_update_draft: t('emailToolUpdateDraft'),
    email_list_outbox_drafts: t('emailToolCreateDraft'),
    email_send_draft: t('emailToolSendDraft'),
  };
  const detail = intent.subject || intent.query || intent.folder;

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/25 px-3 py-2 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          intent.status === 'running' ? 'animate-pulse bg-amber-500' : 'bg-emerald-500',
        )} />
        <span className="font-medium text-foreground">
          {toolLabels[intent.toolName] || t('emailSurface')}
        </span>
        <span className="text-muted-foreground">
          {intent.status === 'running' ? t('contextToolRunning') : t('contextToolComplete')}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {intent.emailAddress ? (
          <span className="hidden max-w-48 truncate font-mono sm:inline">{intent.emailAddress}</span>
        ) : null}
        {detail ? <span className="min-w-0 truncate">{detail}</span> : null}
      </div>
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
  const locale = useLocale();
  const tNotebook = useTranslations('notebook');
  const tCommon = useTranslations('common');
  const tNav = useTranslations('navigation');
  const searchParams = useSearchParams();
  const layout = useNotebookLayoutController();
  const { state, dispatch, setChatDocked } = layout;
  const setChatDockedRef = useRef(setChatDocked);
  const [mobileExplorerOpen, setMobileExplorerOpen] = useState(false);
  const [activeChatContext, setActiveChatContext] = useState<{
    agentId: string;
    sessionId: string;
  } | null>(null);
  const [activeRuntimeStatus, setActiveRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [browserActivityOpen, setBrowserActivityOpen] = useState(false);
  const [documentTabs, setDocumentTabs] = useState<NotebookDocumentTabsState>(
    emptyNotebookDocumentTabsState,
  );
  const [documentTabsHydratedFor, setDocumentTabsHydratedFor] = useState<string | null>(null);
  const desktopExplorerRef = useRef<HTMLDivElement | null>(null);
  const desktopMainPanelRef = useRef<HTMLDivElement | null>(null);
  const desktopChatRef = useRef<HTMLDivElement | null>(null);
  const surfaceTabsRef = useRef<HTMLDivElement | null>(null);
  const openedPathRef = useRef<string | null>(null);
  const initialNotebookStateResolvedRef = useRef(false);
  const previousCurrentFileIdentityRef = useRef<string | null>(null);
  const documentTabsRef = useRef(documentTabs);
  const documentTabsWorkspaceIdRef = useRef<string | null>(null);

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
    if (surface === 'browser') {
      setBrowserActivityOpen(true);
    }
    dispatch({ type: 'CONTEXT_OPENED', surface });
    if (surface === 'browser' && layout.canDockChat) {
      dispatch({ type: 'SET_CHAT_DOCKED', docked: true });
    }
  }, [dispatch, layout.canDockChat]);
  const handleContextUnavailable = useCallback((surface: NotebookContextSurface) => {
    if (surface === 'browser') {
      setBrowserActivityOpen(false);
    }
    dispatch({ type: 'CONTEXT_CLOSED', surface });
  }, [dispatch]);
  const {
    emailContext,
    browserContext,
    clearEmail,
    clearBrowser,
  } = useNotebookToolContext({
    chatContext: activeChatContext,
    runtimeStatus: activeRuntimeStatus,
    onOpen: handleContextOpen,
    onClose: handleContextUnavailable,
  });

  const notebookChatPlacement = state.mainSurface === 'chat'
    ? 'full' as const
    : state.chatDocked
      ? 'side' as const
      : !layout.canDockChat && browserActivityOpen && state.mainSurface === 'browser'
        ? 'overlay' as const
        : 'hidden' as const;
  const resolvedNotebookChatContext = useMemo(() => resolveNotebookChatContext({
    activeDocumentPath: documentTabs.activePath,
    chatPlacement: notebookChatPlacement,
    mainSurface: state.mainSurface,
    openDocumentPaths: documentTabs.openPaths,
  }), [documentTabs.activePath, documentTabs.openPaths, notebookChatPlacement, state.mainSurface]);

  const requestContext = useMemo<ChatRequestContext>(() => {
    let surfaceContext: ChatRequestContext;
    if (state.mainSurface === 'email' && emailChatContext) {
      surfaceContext = emailChatContext;
    } else if (state.mainSurface === 'browser') {
      surfaceContext = { currentPage: '/browser/live' };
    } else {
      surfaceContext = { currentPage: '/notebook' };
    }
    return {
      ...surfaceContext,
      activeFilePath: resolvedNotebookChatContext.activeFilePath,
      notebookContext: resolvedNotebookChatContext.notebookContext,
    };
  }, [emailChatContext, resolvedNotebookChatContext, state.mainSurface]);

  const currentDirectoryLabel =
    currentDirectory === '.' ? tNotebook('workspaceRoot') : `/${currentDirectory}`;

  const replaceDocumentTabs = useCallback((
    workspaceId: string,
    nextState: NotebookDocumentTabsState,
  ) => {
    if (documentTabsWorkspaceIdRef.current !== workspaceId) return;
    documentTabsRef.current = nextState;
    setDocumentTabs(nextState);
    try {
      writeNotebookDocumentTabs(window.localStorage, workspaceId, nextState);
      if (nextState.activePath) {
        writeStoredNotebookOpenFilePath(window.localStorage, workspaceId, nextState.activePath);
      } else {
        clearStoredNotebookOpenFilePath(window.localStorage, workspaceId);
      }
    } catch {
      // Local UI persistence is non-critical.
    }
  }, []);

  const hydrateDocumentTabs = useCallback((workspaceId: string) => {
    let nextState = emptyNotebookDocumentTabsState();
    try {
      clearLegacyStoredNotebookOpenFilePath(window.localStorage);
      nextState = readNotebookDocumentTabs(window.localStorage, workspaceId);
    } catch {
      // Start without restored tabs when local persistence is unavailable.
    }
    documentTabsWorkspaceIdRef.current = workspaceId;
    documentTabsRef.current = nextState;
    setDocumentTabs(nextState);
    setDocumentTabsHydratedFor(workspaceId);
    return nextState;
  }, []);

  useEffect(() => registerNotebookDocumentOpenGuard(({ path, workspaceId }) => {
    const currentWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId;
    if (
      !workspaceId
      || workspaceId !== currentWorkspaceId
      || documentTabsWorkspaceIdRef.current !== workspaceId
    ) {
      return { allowed: true };
    }

    const result = openNotebookDocumentTab(documentTabsRef.current, path);
    return result.status === 'limit-reached'
      ? {
          allowed: false,
          error: tNotebook('documentTabLimitReached', {
            count: NOTEBOOK_MAX_OPEN_DOCUMENTS,
          }),
        }
      : { allowed: true };
  }), [tNotebook]);

  const showOpenedDocument = useCallback((dockChatIfFull = false) => {
    dispatch({
      type: 'DOCUMENT_OPENED',
      dockChatIfFull: dockChatIfFull && layout.chatDockedPreference,
    });
  }, [dispatch, layout.chatDockedPreference]);

  const openNotebookFile = useCallback(async (
    path: string,
    options: OpenNotebookFileOptions = {},
  ) => {
    const normalizedPath = normalizeNotebookFilePath(path);
    if (!normalizedPath) return null;

    showOpenedDocument(options.dockChatIfFull);
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
  }, [showOpenedDocument]);

  const openBridgedNotebookFile = useCallback(async (request: NotebookFileReferenceRequest) => {
    openedPathRef.current = request.path;
    const result = await openNotebookFile(request.path, { dockChatIfFull: true });
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
    if (!activeWorkspaceId || documentTabsHydratedFor !== activeWorkspaceId) return;
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
  }, [
    activeWorkspaceId,
    dispatch,
    documentTabsHydratedFor,
    openNotebookFile,
    routeFilePath,
    shouldOpenRouteChat,
  ]);

  useEffect(() => {
    if (
      window.name !== NOTEBOOK_WINDOW_NAME
      || !activeWorkspaceId
      || documentTabsHydratedFor !== activeWorkspaceId
    ) return;
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const request = parseNotebookFileReferenceRequest(event.data);
      if (request) void openBridgedNotebookFile(request);
    };
    window.addEventListener('message', handleMessage);
    const pendingRequest = readPendingNotebookFileReference();
    if (pendingRequest) queueMicrotask(() => void openBridgedNotebookFile(pendingRequest));
    return () => window.removeEventListener('message', handleMessage);
  }, [activeWorkspaceId, documentTabsHydratedFor, openBridgedNotebookFile]);

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
    const restoredTabs = hydrateDocumentTabs(activeWorkspaceId);
    if (routeFilePath) {
      if (shouldForceChatOpen) dispatch({ type: 'SHOW_CHAT' });
      return;
    }

    if (restoredTabs.activePath) {
      openedPathRef.current = restoredTabs.activePath;
      void openNotebookFile(restoredTabs.activePath);
      if (shouldForceChatOpen) dispatch({ type: 'SHOW_CHAT' });
      return;
    }

    useFileStore.getState().clearCurrentFile();
    dispatch({ type: 'DOCUMENT_CLOSED' });
    dispatch({ type: 'SHOW_CHAT' });
  }, [
    activeWorkspaceId,
    dispatch,
    hydrateDocumentTabs,
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
      if (documentTabsWorkspaceIdRef.current === workspaceId) {
        const result = openNotebookDocumentTab(documentTabsRef.current, nextPath);
        if (result.status !== 'limit-reached') {
          replaceDocumentTabs(workspaceId, result.state);
        }
      }
    });
  }, [replaceDocumentTabs]);

  useEffect(() => {
    const handleWorkspaceChange = (event: Event) => {
      const { activeWorkspaceId: nextWorkspaceId } =
        (event as CustomEvent<WorkspaceChangedDetail>).detail;
      openedPathRef.current = routeFilePath;
      previousCurrentFileIdentityRef.current = null;
      useFileStore.getState().resetWorkspaceView(nextWorkspaceId);
      useEditorStore.getState().clear();
      const restoredTabs = hydrateDocumentTabs(nextWorkspaceId);
      clearEmail();
      clearBrowser();
      dispatch({ type: 'DOCUMENT_CLOSED' });
      dispatch({ type: 'CONTEXT_CLOSED', surface: 'email' });
      dispatch({ type: 'CONTEXT_CLOSED', surface: 'browser' });

      if (routeFilePath) return;
      if (!restoredTabs.activePath) {
        dispatch({ type: 'SHOW_CHAT' });
        return;
      }
      openedPathRef.current = restoredTabs.activePath;
      window.setTimeout(() => {
        if (useWorkspaceStore.getState().activeWorkspaceId === nextWorkspaceId) {
          void openNotebookFile(restoredTabs.activePath!);
        }
      }, 0);
    };
    window.addEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
    return () => window.removeEventListener(WORKSPACE_CHANGED_EVENT, handleWorkspaceChange);
  }, [clearBrowser, clearEmail, dispatch, hydrateDocumentTabs, openNotebookFile, routeFilePath]);

  useEffect(() => {
    const handleWorkspaceFileOpen = () => {
      showOpenedDocument(true);
      setMobileExplorerOpen(false);
    };
    window.addEventListener(WORKSPACE_FILE_OPENED_EVENT, handleWorkspaceFileOpen);
    return () => window.removeEventListener(WORKSPACE_FILE_OPENED_EVENT, handleWorkspaceFileOpen);
  }, [showOpenedDocument]);

  const flushActiveDocument = useCallback(async (path: string) => {
    const editorState = useEditorStore.getState();
    if (editorState.activePath !== path || !editorState.isDirty) return true;

    try {
      editorState.markSaving();
      const contentToSave = editorState.draft;
      await useFileStore.getState().saveFile(path, contentToSave, activeWorkspaceId);
      const latestEditorState = useEditorStore.getState();
      if (
        latestEditorState.activePath !== path
        || latestEditorState.draft !== contentToSave
      ) {
        latestEditorState.setSaveError(tNotebook('fileChangedWhileClosing'));
        toast.error(tNotebook('fileChangedWhileClosing'));
        return false;
      }
      latestEditorState.markSaved();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : tNotebook('failedToSaveFile');
      useEditorStore.getState().setSaveError(message);
      toast.error(message);
      return false;
    }
  }, [activeWorkspaceId, tNotebook]);

  const handleCloseDocumentTab = useCallback(async (path: string) => {
    if (!activeWorkspaceId || documentTabsWorkspaceIdRef.current !== activeWorkspaceId) return;
    const currentTabs = documentTabsRef.current;
    if (!currentTabs.openPaths.includes(path)) return;

    if (currentTabs.activePath !== path) {
      replaceDocumentTabs(activeWorkspaceId, closeNotebookDocumentTab(currentTabs, path));
      return;
    }

    const closingResult = closeNotebookDocumentTab(currentTabs, path);
    if (closingResult.activePath) {
      const openResult = await openNotebookFile(closingResult.activePath);
      if (openResult?.status !== 'opened') {
        if (openResult?.status !== 'superseded') {
          toast.error(openResult?.error || tNotebook('failedToLoadPreview'));
        }
        return;
      }
      replaceDocumentTabs(
        activeWorkspaceId,
        closeNotebookDocumentTab(documentTabsRef.current, path),
      );
      return;
    }

    if (!(await flushActiveDocument(path))) return;
    useFileStore.getState().clearCurrentFile();
    useEditorStore.getState().clear();
    openedPathRef.current = null;
    replaceDocumentTabs(activeWorkspaceId, closingResult);
    dispatch({ type: 'DOCUMENT_CLOSED' });
  }, [
    activeWorkspaceId,
    dispatch,
    flushActiveDocument,
    openNotebookFile,
    replaceDocumentTabs,
    tNotebook,
  ]);

  const handleCloseDocument = useCallback(() => {
    const activePath = documentTabsRef.current.activePath;
    if (activePath) void handleCloseDocumentTab(activePath);
  }, [handleCloseDocumentTab]);

  useEffect(() => {
    const closeDocumentTabsAtPaths = (paths: Iterable<string>) => {
      if (!activeWorkspaceId || documentTabsWorkspaceIdRef.current !== activeWorkspaceId) return;
      const closedPaths = Array.from(paths);
      const nextTabs = closeNotebookDocumentTabsAtPaths(documentTabsRef.current, closedPaths);
      if (nextTabs === documentTabsRef.current) return;

      const currentFilePath = useFileStore.getState().currentFile?.path ?? null;
      replaceDocumentTabs(activeWorkspaceId, nextTabs);
      if (nextTabs.activePath) {
        if (currentFilePath !== nextTabs.activePath) {
          void openNotebookFile(nextTabs.activePath);
        }
        return;
      }

      useFileStore.getState().clearCurrentFile();
      useEditorStore.getState().clear();
      openedPathRef.current = null;
      dispatch({ type: 'DOCUMENT_CLOSED' });
    };
    const handlePathsDeleted = (event: Event) => {
      const { paths } = (event as CustomEvent<WorkspacePathsDeletedDetail>).detail;
      closeDocumentTabsAtPaths(paths);
    };
    const handlePathRenamed = (event: Event) => {
      if (!activeWorkspaceId || documentTabsWorkspaceIdRef.current !== activeWorkspaceId) return;
      const { oldPath, newPath } = (event as CustomEvent<WorkspacePathRenamedDetail>).detail;
      replaceDocumentTabs(
        activeWorkspaceId,
        renameNotebookDocumentTabs(documentTabsRef.current, oldPath, newPath),
      );
    };
    const handleWatcherFileChange = (event: Event) => {
      const detail = (event as CustomEvent<FileEvent>).detail;
      if (
        !detail
        || (detail.type !== 'unlink' && detail.type !== 'unlinkDir')
        || (detail.workspaceId && detail.workspaceId !== activeWorkspaceId)
      ) {
        return;
      }
      closeDocumentTabsAtPaths([detail.relativePath]);
    };
    const fileWatcher = getFileWatcherClient();
    window.addEventListener(WORKSPACE_PATHS_DELETED_EVENT, handlePathsDeleted);
    window.addEventListener(WORKSPACE_PATH_RENAMED_EVENT, handlePathRenamed);
    fileWatcher.addEventListener('filechange', handleWatcherFileChange);
    return () => {
      window.removeEventListener(WORKSPACE_PATHS_DELETED_EVENT, handlePathsDeleted);
      window.removeEventListener(WORKSPACE_PATH_RENAMED_EVENT, handlePathRenamed);
      fileWatcher.removeEventListener('filechange', handleWatcherFileChange);
    };
  }, [activeWorkspaceId, dispatch, openNotebookFile, replaceDocumentTabs]);

  const handleCloseContext = useCallback((surface: NotebookContextSurface) => {
    if (surface === 'email') clearEmail();
    else {
      clearBrowser();
      setBrowserActivityOpen(false);
    }
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
          setChatDockedRef.current(!state.chatDocked);
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
  const openLiveBrowser = useCallback(() => {
    setBrowserActivityOpen(true);
    dispatch({ type: 'CONTEXT_OPENED', surface: 'browser' });
    if (layout.canDockChat) {
      dispatch({ type: 'SET_CHAT_DOCKED', docked: true });
    }
  }, [dispatch, layout.canDockChat]);
  const browserActivityUsesSheet =
    !layout.canDockChat && browserActivityOpen && state.mainSurface === 'browser';
  const browserActivityVisible = layout.canDockChat
    ? state.chatDocked
    : browserActivityUsesSheet;
  const toggleBrowserActivity = useCallback(() => {
    if (layout.canDockChat) {
      const open = !state.chatDocked;
      setBrowserActivityOpen(open);
      dispatch({ type: 'SET_CHAT_DOCKED', docked: open });
      return;
    }
    setBrowserActivityOpen((open) => !open);
  }, [dispatch, layout.canDockChat, state.chatDocked]);
  const handleFileSelected = useCallback(() => {
    showOpenedDocument(true);
    setMobileExplorerOpen(false);
  }, [showOpenedDocument]);
  const handleSelectDocumentTab = useCallback(async (path: string) => {
    if (documentTabsRef.current.activePath === path && currentFile?.path === path) {
      showOpenedDocument(true);
      return;
    }
    const result = await openNotebookFile(path, { dockChatIfFull: true });
    if (result?.status !== 'opened' && result?.status !== 'superseded') {
      toast.error(result?.error || tNotebook('failedToLoadPreview'));
    }
  }, [currentFile?.path, openNotebookFile, showOpenedDocument, tNotebook]);

  const chatVisible =
    state.mainSurface === 'chat' || state.chatDocked || browserActivityUsesSheet;
  const chatContent = (
    <CanvasAgentChat
      initialPromptStorageKey={CANVAS_CHAT_INITIAL_PROMPT_STORAGE_KEY}
      hideNavHeader
      showWorkspaceSwitcher={false}
      forcedSessionId={forcedSessionId}
      requestContext={requestContext}
      isSurfaceVisible={chatVisible}
      onRuntimeStatusChange={setActiveRuntimeStatus}
      onSessionContextChange={setActiveChatContext}
      onOpenLiveBrowser={openLiveBrowser}
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
  const surfacePanelIds = {
    chat: layout.isMobile ? 'notebook-mobile-chat' : 'onboarding-notebook-chat',
    document: layout.isMobile ? 'notebook-mobile-document' : 'notebook-desktop-document',
    email: layout.isMobile ? 'notebook-mobile-email' : 'notebook-desktop-email',
    browser: layout.isMobile ? 'notebook-mobile-browser' : 'notebook-desktop-browser',
  };
  const activeDocumentTabIndex = documentTabs.activePath
    ? documentTabs.openPaths.indexOf(documentTabs.activePath)
    : -1;
  const activeDocumentTabId = activeDocumentTabIndex >= 0
    ? `notebook-document-${activeDocumentTabIndex}-tab`
    : 'notebook-surface-document-tab';

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => {
      const strip = surfaceTabsRef.current;
      const activeTab = strip?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!strip || !activeTab) return;

      const delta = getNotebookTabRevealDelta(
        strip.getBoundingClientRect(),
        activeTab.getBoundingClientRect(),
      );
      if (Math.abs(delta) < 1) return;

      strip.scrollBy({
        left: delta,
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [documentTabs.activePath, documentTabs.openPaths, state.mainSurface]);

  return (
    <FileWatcherProvider>
      <HintProvider page="notebook" enabled={hintEnabled}>
        <div className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground">
          <header className="z-40 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/88 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <AppBackButton fallbackHref="/" className="shrink-0 gap-2 px-2 sm:px-3" />
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
              ref={surfaceTabsRef}
              role="tablist"
              aria-label={tNotebook('surfaceTabsLabel')}
              className="flex min-w-0 flex-1 touch-pan-x items-center gap-1 overflow-x-auto overscroll-x-contain scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            >
              <SurfaceTab
                active={state.mainSurface === 'chat'}
                controlsId={surfacePanelIds.chat}
                icon={<MessageSquare className="h-3.5 w-3.5 shrink-0" />}
                label={tCommon('aiChat')}
                onSelect={showChat}
                testId="notebook-surface-chat"
              />
              {documentTabs.openPaths.map((path, index) => {
                const label = path.split('/').filter(Boolean).pop() || path;
                return (
                  <SurfaceTab
                    key={path}
                    active={
                      state.mainSurface === 'document'
                      && documentTabs.activePath === path
                    }
                    closeLabel={tNotebook('closeDocumentTab', { name: label })}
                    controlsId={surfacePanelIds.document}
                    icon={<FileText className="h-3.5 w-3.5 shrink-0" />}
                    label={label}
                    onClose={() => void handleCloseDocumentTab(path)}
                    onSelect={() => void handleSelectDocumentTab(path)}
                    testId={`notebook-document-${index}`}
                  />
                );
              })}
              {state.emailAvailable ? (
                <SurfaceTab
                  active={state.mainSurface === 'email'}
                  closeLabel={tNotebook('closeEmailSurface')}
                  controlsId={surfacePanelIds.email}
                  icon={<Mail className="h-3.5 w-3.5 shrink-0" />}
                  label={tNotebook('emailSurface')}
                  onClose={() => handleCloseContext('email')}
                  onSelect={() => showSurface('email')}
                  testId="notebook-surface-email"
                />
              ) : null}
              {state.browserAvailable ? (
                <SurfaceTab
                  active={state.mainSurface === 'browser'}
                  closeLabel={tNotebook('closeBrowserSurface')}
                  controlsId={surfacePanelIds.browser}
                  icon={<Globe2 className="h-3.5 w-3.5 shrink-0" />}
                  label={tNotebook('browserSurface')}
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
                        onClick={() => setChatDocked(!state.chatDocked)}
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
              <SurfaceLayer
                active={state.mainSurface === 'document'}
                labelledBy={activeDocumentTabId}
                testId="notebook-mobile-document"
              >
                {documentContent}
              </SurfaceLayer>
              <SurfaceLayer
                active={state.mainSurface === 'email'}
                labelledBy="notebook-surface-email-tab"
                testId="notebook-mobile-email"
              >
                {emailContext ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <EmailContextHeader intent={emailContext} />
                    <div className="min-h-0 flex-1">
                      <EmailClient contextIntent={emailContext} embedded />
                    </div>
                  </div>
                ) : null}
              </SurfaceLayer>
              <SurfaceLayer
                active={state.mainSurface === 'browser'}
                labelledBy="notebook-surface-browser-tab"
                testId="notebook-mobile-browser"
              >
                {browserContext ? (
                  <div className="flex h-full min-h-0 flex-col">
                    <BrowserContextHeader
                      activityControlsId="browser-agent-activity-panel"
                      activityVisible={browserActivityVisible}
                      context={browserContext}
                      onToggleActivity={toggleBrowserActivity}
                    />
                    <div className="min-h-0 flex-1">
                      <BrowserLabClient
                        autoConnectKey={browserContext.sessionId}
                        enabled={state.mainSurface === 'browser'}
                        locale={locale}
                        presentation="embedded"
                        variant="live"
                        agentId={browserContext.agentId}
                        sessionId={browserContext.sessionId}
                      />
                    </div>
                  </div>
                ) : null}
              </SurfaceLayer>
              <SurfaceLayer
                active={state.mainSurface === 'chat' || browserActivityUsesSheet}
                labelledBy="notebook-surface-chat-tab"
                testId="notebook-mobile-chat"
              >
                <div
                  id="browser-agent-activity-panel"
                  data-testid={browserActivityUsesSheet
                    ? 'browser-agent-activity-sheet'
                    : undefined}
                  role={browserActivityUsesSheet ? 'dialog' : undefined}
                  aria-modal={browserActivityUsesSheet || undefined}
                  aria-label={browserActivityUsesSheet
                    ? tNotebook('agentActivity')
                    : undefined}
                  className="flex h-full min-h-0 flex-col"
                >
                  {browserActivityUsesSheet ? (
                    <BrowserActivityPanelHeader onClose={() => setBrowserActivityOpen(false)} />
                  ) : null}
                  <div className="min-h-0 flex-1">
                    {chatContent}
                  </div>
                </div>
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

              <div
                ref={desktopMainPanelRef}
                className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
              >
                <div
                  className={cn(
                    'min-h-0 min-w-0 flex-1',
                    state.mainSurface === 'chat' && 'hidden',
                  )}
                >
                  <AppLayout
                    sidebar={<div />}
                    sidebarHidden
                    terminalVisible={state.terminalOpen}
                    sidebarResizeLabel={tNotebook('resizeFileTree')}
                    terminalResizeLabel={tNotebook('resizeTerminal')}
                    main={
                      <div
                        id="onboarding-notebook-editor"
                        className="relative h-full min-h-0 min-w-0 overflow-hidden bg-background"
                      >
                        <SurfaceLayer
                          active={state.mainSurface === 'document'}
                          labelledBy={activeDocumentTabId}
                          testId="notebook-desktop-document"
                        >
                          {documentContent}
                        </SurfaceLayer>
                        <SurfaceLayer
                          active={state.mainSurface === 'email'}
                          labelledBy="notebook-surface-email-tab"
                          testId="notebook-desktop-email"
                        >
                          {emailContext ? (
                            <div className="flex h-full min-h-0 flex-col">
                              <EmailContextHeader intent={emailContext} />
                              <div className="min-h-0 flex-1">
                                <EmailClient contextIntent={emailContext} embedded />
                              </div>
                            </div>
                          ) : null}
                        </SurfaceLayer>
                        <SurfaceLayer
                          active={state.mainSurface === 'browser'}
                          labelledBy="notebook-surface-browser-tab"
                          testId="notebook-desktop-browser"
                        >
                          {browserContext ? (
                            <div className="flex h-full min-h-0 flex-col">
                              <BrowserContextHeader
                                activityControlsId="browser-agent-activity-panel"
                                activityVisible={browserActivityVisible}
                                context={browserContext}
                                onToggleActivity={toggleBrowserActivity}
                              />
                              <div className="min-h-0 flex-1">
                                <BrowserLabClient
                                  autoConnectKey={browserContext.sessionId}
                                  enabled={state.mainSurface === 'browser'}
                                  locale={locale}
                                  presentation="embedded"
                                  variant="live"
                                  agentId={browserContext.agentId}
                                  sessionId={browserContext.sessionId}
                                />
                              </div>
                            </div>
                          ) : null}
                        </SurfaceLayer>
                      </div>
                    }
                    terminal={<TerminalPanel />}
                  />
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
                  data-chat-placement={state.mainSurface === 'chat'
                    ? 'main'
                    : state.chatDocked
                      ? 'side'
                      : browserActivityUsesSheet
                        ? 'overlay'
                        : 'hidden'}
                  role={browserActivityUsesSheet
                    ? 'dialog'
                    : state.mainSurface === 'chat'
                      ? 'tabpanel'
                      : 'complementary'}
                  aria-labelledby={state.mainSurface === 'chat' ? 'notebook-surface-chat-tab' : undefined}
                  aria-label={browserActivityUsesSheet
                    ? tNotebook('agentActivity')
                    : state.chatDocked
                      ? tCommon('aiChat')
                      : undefined}
                  aria-modal={browserActivityUsesSheet || undefined}
                  aria-hidden={!chatVisible}
                  inert={!chatVisible}
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
                        : browserActivityUsesSheet
                          ? 'absolute inset-y-0 right-0 z-40 w-full max-w-[30rem] border-l border-border shadow-2xl'
                          : 'hidden',
                  )}
                >
                  <div
                    id="browser-agent-activity-panel"
                    data-testid={browserActivityUsesSheet
                      ? 'browser-agent-activity-sheet'
                      : undefined}
                    className="flex h-full min-h-0 flex-col"
                  >
                    {browserActivityUsesSheet ? (
                      <BrowserActivityPanelHeader onClose={() => setBrowserActivityOpen(false)} />
                    ) : null}
                    <div className="min-h-0 flex-1">
                      {chatContent}
                    </div>
                  </div>
                </div>
              </div>
            </main>
          )}

        </div>
      </HintProvider>
    </FileWatcherProvider>
  );
}
