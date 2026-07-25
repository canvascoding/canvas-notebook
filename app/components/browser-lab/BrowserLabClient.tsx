'use client';

import {
  ArrowLeft,
  ArrowLeftRight,
  Bot,
  CircleDot,
  Download,
  ExternalLink,
  FileUp,
  Globe2,
  Hand,
  Loader2,
  LockKeyhole,
  MessageSquare,
  MonitorUp,
  RefreshCw,
  ShieldAlert,
  SquareMousePointer,
  Unplug,
  UserRound,
} from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from 'react';

import type { AgentProfile, AISession } from '@/app/lib/chat/types';
import { buildChatSessionHref } from '@/app/lib/chat/chat-navigation-intent';
import type {
  BrowserViewControlMode,
  BrowserViewErrorCode,
  BrowserViewFailure,
  BrowserViewState,
} from '@/app/lib/pi/browser/types';
import { closeBrowserWebSocket } from '@/app/lib/pi/browser/client-websocket';
import { Link } from '@/i18n/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type BrowserLabClientProps = {
  agentId?: string;
  locale: string;
  sessionId?: string;
  variant?: 'lab' | 'live';
};

type ViewTicketResponse = {
  success?: boolean;
  code?: BrowserViewErrorCode;
  error?: string;
  retryable?: boolean;
  fatal?: boolean;
  data?: {
    ticket: string;
    viewId: string;
    expiresAt: string;
    websocketUrl: string;
  };
};

type BrowserSocketMessage =
  | { type: 'auth_success' }
  | { type: 'ready'; viewId: string }
  | { type: 'frame'; sequence: number; mimeType: string; data: string; width: number; height: number }
  | { type: 'state'; state: BrowserViewState }
  | ({ type: 'error' } & BrowserViewFailure);

type ConnectionStatus = 'connecting' | 'failed' | 'idle' | 'live';

type WorkspaceBrowserFile = {
  name: string;
  path: string;
  size: number;
  selectable: boolean;
};

const copy = {
  de: {
    eyebrow: 'Entwicklungswerkzeug',
    title: 'Browser Lab',
    description: 'Dieselbe Chromium-Seite beobachten und steuern, die der Agent in seiner Session verwendet.',
    liveEyebrow: 'Aktueller Chat',
    liveTitle: 'Live-Browser',
    liveDescription: 'Verfolge die Browserarbeit des Agenten live oder übernimm die Steuerung, wenn du selbst eingreifen möchtest.',
    backToChat: 'Zurück zum Chat',
    openChat: 'Chat öffnen',
    currentChat: 'Aktueller Chat',
    context: 'Kontext',
    status: 'Status',
    contextUnavailable: 'Dieser Chat ist für die Live-Browser-Ansicht nicht mehr verfügbar.',
    agent: 'Agent',
    session: 'Chat-Session',
    chooseSession: 'Session auswählen',
    noSessions: 'Keine PI-Chat-Session für diesen Agenten vorhanden.',
    connect: 'Live-Ansicht starten',
    reconnect: 'Neu verbinden',
    retry: 'Erneut versuchen',
    disconnect: 'Trennen',
    dismissError: 'Meldung schließen',
    loading: 'Browser-Ansicht wird vorbereitet …',
    disconnected: 'Nicht verbunden',
    failed: 'Verbindung unterbrochen',
    connecting: 'Verbindung wird aufgebaut',
    live: 'Live verbunden',
    failureTitle: 'Die Live-Ansicht braucht Aufmerksamkeit',
    failureDescription: 'Das letzte Browserbild bleibt zur Orientierung sichtbar. Eingaben sind bis zur erneuten Verbindung gesperrt.',
    address: 'Adresse',
    navigate: 'Öffnen',
    takeControl: 'Übernehmen',
    giveAgent: 'An Agenten geben',
    viewOnly: 'Nur ansehen',
    modeAgent: 'Agent steuert',
    modeUser: 'Nutzer steuert',
    modeView: 'Ansehen',
    takeoverWarning: 'Eine laufende Agentenantwort wird bei der Übernahme kontrolliert abgebrochen.',
    emptyTitle: 'Noch kein Browserbild',
    emptyDescription: 'Wähle Agent und Chat-Session aus und starte anschließend die Live-Ansicht.',
    inputHint: 'Klicke in das Browserbild, um Maus und Tastatur dorthin zu senden.',
    diagnostics: 'Diagnose',
    workspace: 'Workspace',
    viewport: 'Viewport',
    frameRate: 'Bildrate',
    memory: 'Effektiver Speicher',
    availableMemory: 'Freier Speicher',
    tabs: 'Tabs',
    dialog: 'Die Webseite zeigt einen Dialog.',
    uploadTitle: 'Workspace-Datei auswählen',
    uploadDescription: 'Die Webseite wartet auf eine Datei. Nur Dateien aus diesem Session-Workspace sind verfügbar.',
    searchWorkspace: 'Workspace-Dateien durchsuchen',
    chooseFile: 'Datei auswählen',
    uploadSelected: 'Ausgewählte Datei verwenden',
    cancelFileChooser: 'Dateiauswahl abbrechen',
    noFiles: 'Keine passenden Workspace-Dateien gefunden.',
    loadingFiles: 'Workspace-Dateien werden geladen …',
    downloads: 'Browser-Downloads',
    downloadInProgress: 'Wird in den Workspace gespeichert',
    downloadReady: 'Über Canvas herunterladen',
    downloadFailed: 'Download fehlgeschlagen',
    sensitiveTitle: 'Privates Eingabefeld aktiv',
    sensitiveDescription: 'Passwort-, Einmalcode- und Zahlungsdaten werden nur an Chromium gesendet und nicht protokolliert.',
    accept: 'Bestätigen',
    dismiss: 'Abbrechen',
    privateNotice: 'Eingaben werden live an Chromium gesendet und nicht protokolliert.',
    errors: {
      CAPACITY_EXHAUSTED: 'Alle verfügbaren Live-Browser-Plätze sind derzeit belegt.',
      CAPTURE_FAILED: 'Das aktuelle Browserbild konnte nicht übertragen werden.',
      CONNECTION_FAILED: 'Die Live-Browser-Verbindung konnte nicht aufgebaut werden.',
      CONNECTION_LOST: 'Die Verbindung zum Live-Browser wurde unerwartet getrennt.',
      CONNECTION_TIMEOUT: 'Der Live-Browser hat nicht rechtzeitig geantwortet.',
      CONTROL_CONFLICT: 'Die Browsersteuerung wird gerade von einer anderen Ansicht verwendet.',
      DOWNLOAD_FAILED: 'Der Browser-Download konnte nicht im Workspace gespeichert werden.',
      DOWNLOAD_TOO_LARGE: 'Der Browser-Download überschreitet die erlaubte Größe.',
      FILE_ACCESS_DENIED: 'Die ausgewählte Datei ist in diesem Session-Workspace nicht verfügbar.',
      FILE_CHOOSER_REQUIRED: 'Wähle zuerst ein Dateifeld auf der Webseite aus.',
      FILE_UPLOAD_FAILED: 'Die ausgewählte Workspace-Datei konnte nicht hochgeladen werden.',
      FORBIDDEN: 'Du hast keinen Zugriff auf diese Browseransicht.',
      INVALID_MESSAGE: 'Die Browseransicht hat eine ungültige Nachricht erhalten.',
      MESSAGE_TOO_LARGE: 'Eine Browsernachricht war zu groß und wurde abgewiesen.',
      NAVIGATION_BLOCKED: 'Diese Adresse wurde durch die Browser-Sicherheitsrichtlinie blockiert.',
      NAVIGATION_FAILED: 'Die Webseite konnte nicht geöffnet werden.',
      OPERATION_FAILED: 'Die Browseraktion konnte nicht abgeschlossen werden.',
      PAGE_CRASHED: 'Die verwaltete Browserseite wurde unerwartet beendet.',
      RATE_LIMITED: 'Zu viele Browseraktionen. Warte kurz und versuche es erneut.',
      RESOURCE_UNAVAILABLE: 'Auf diesem System stehen nicht genug Ressourcen für die Live-Ansicht bereit.',
      SESSION_SCOPE_CHANGED: 'Die Chat- oder Workspace-Zuordnung hat sich geändert. Öffne die Ansicht erneut.',
      TICKET_EXPIRED: 'Die kurzlebige Zugriffsberechtigung ist abgelaufen.',
      UNAUTHORIZED: 'Deine Anmeldung ist für diese Browseransicht nicht mehr gültig.',
      VIEW_CONFLICT: 'Diese Browseransicht ist bereits mit einer anderen Verbindung geöffnet.',
    },
  },
  en: {
    eyebrow: 'Development tool',
    title: 'Browser Lab',
    description: 'Observe and control the same Chromium page used by the agent in its session.',
    liveEyebrow: 'Current chat',
    liveTitle: 'Live Browser',
    liveDescription: 'Follow the agent’s browser work live or take control when you want to step in yourself.',
    backToChat: 'Back to chat',
    openChat: 'Open chat',
    currentChat: 'Current chat',
    context: 'Context',
    status: 'Status',
    contextUnavailable: 'This chat is no longer available for the live-browser view.',
    agent: 'Agent',
    session: 'Chat session',
    chooseSession: 'Choose a session',
    noSessions: 'No PI chat session exists for this agent.',
    connect: 'Start live view',
    reconnect: 'Reconnect',
    retry: 'Try again',
    disconnect: 'Disconnect',
    dismissError: 'Dismiss message',
    loading: 'Preparing browser view…',
    disconnected: 'Disconnected',
    failed: 'Connection interrupted',
    connecting: 'Connecting',
    live: 'Live connected',
    failureTitle: 'The live view needs attention',
    failureDescription: 'The last browser frame remains visible for context. Input stays locked until you reconnect.',
    address: 'Address',
    navigate: 'Open',
    takeControl: 'Take control',
    giveAgent: 'Give to agent',
    viewOnly: 'View only',
    modeAgent: 'Agent controls',
    modeUser: 'User controls',
    modeView: 'Viewing',
    takeoverWarning: 'Taking control cleanly aborts an active agent response.',
    emptyTitle: 'No browser frame yet',
    emptyDescription: 'Choose an agent and chat session, then start the live view.',
    inputHint: 'Click the browser frame to send mouse and keyboard input.',
    diagnostics: 'Diagnostics',
    workspace: 'Workspace',
    viewport: 'Viewport',
    frameRate: 'Frame rate',
    memory: 'Effective memory',
    availableMemory: 'Available memory',
    tabs: 'Tabs',
    dialog: 'The webpage opened a dialog.',
    uploadTitle: 'Choose a workspace file',
    uploadDescription: 'The webpage is waiting for a file. Only files from this session workspace are available.',
    searchWorkspace: 'Search workspace files',
    chooseFile: 'Choose file',
    uploadSelected: 'Use selected file',
    cancelFileChooser: 'Cancel file selection',
    noFiles: 'No matching workspace files were found.',
    loadingFiles: 'Loading workspace files…',
    downloads: 'Browser downloads',
    downloadInProgress: 'Saving to the workspace',
    downloadReady: 'Download through Canvas',
    downloadFailed: 'Download failed',
    sensitiveTitle: 'Private input is active',
    sensitiveDescription: 'Password, one-time-code, and payment data is sent only to Chromium and is not logged.',
    accept: 'Accept',
    dismiss: 'Dismiss',
    privateNotice: 'Input is sent live to Chromium and is not logged.',
    errors: {
      CAPACITY_EXHAUSTED: 'All available live-browser slots are currently in use.',
      CAPTURE_FAILED: 'The current browser frame could not be delivered.',
      CONNECTION_FAILED: 'The live-browser connection could not be established.',
      CONNECTION_LOST: 'The live-browser connection closed unexpectedly.',
      CONNECTION_TIMEOUT: 'The live browser did not respond in time.',
      CONTROL_CONFLICT: 'Browser control is currently held by another view.',
      DOWNLOAD_FAILED: 'The browser download could not be saved to the workspace.',
      DOWNLOAD_TOO_LARGE: 'The browser download exceeds the allowed size.',
      FILE_ACCESS_DENIED: 'The selected file is not available in this session workspace.',
      FILE_CHOOSER_REQUIRED: 'Choose a file field in the webpage first.',
      FILE_UPLOAD_FAILED: 'The selected workspace file could not be uploaded.',
      FORBIDDEN: 'You do not have access to this browser view.',
      INVALID_MESSAGE: 'The browser view received an invalid message.',
      MESSAGE_TOO_LARGE: 'A browser message was too large and was rejected.',
      NAVIGATION_BLOCKED: 'This address was blocked by the browser security policy.',
      NAVIGATION_FAILED: 'The webpage could not be opened.',
      OPERATION_FAILED: 'The browser action could not be completed.',
      PAGE_CRASHED: 'The managed browser page stopped unexpectedly.',
      RATE_LIMITED: 'Too many browser actions. Wait briefly and try again.',
      RESOURCE_UNAVAILABLE: 'This system does not have enough resources for the live view.',
      SESSION_SCOPE_CHANGED: 'The chat or workspace scope changed. Open the view again.',
      TICKET_EXPIRED: 'The short-lived browser permission expired.',
      UNAUTHORIZED: 'Your sign-in is no longer valid for this browser view.',
      VIEW_CONFLICT: 'This browser view is already open in another connection.',
    },
  },
} as const;

type BrowserLabCopy = (typeof copy)[keyof typeof copy];

function localizedFailure(t: BrowserLabCopy, failure: BrowserViewFailure): BrowserViewFailure {
  return { ...failure, error: t.errors[failure.code] || failure.error };
}

function clientFailure(
  t: BrowserLabCopy,
  code: BrowserViewErrorCode,
  retryable: boolean,
  fatal: boolean,
): BrowserViewFailure {
  return { code, error: t.errors[code], retryable, fatal };
}

function socketUrl(pathname: string): string {
  const url = new URL(pathname, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function mouseButton(button: number): 'left' | 'middle' | 'right' {
  if (button === 1) return 'middle';
  if (button === 2) return 'right';
  return 'left';
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

export function BrowserLabClient({
  agentId,
  locale,
  sessionId,
  variant = 'lab',
}: BrowserLabClientProps) {
  const t = locale === 'en' ? copy.en : copy.de;
  const searchParams = useSearchParams();
  const isLiveView = variant === 'live';
  const initialAgentId = isLiveView ? agentId?.trim() || '' : searchParams.get('agentId')?.trim() || '';
  const initialSessionId = isLiveView ? sessionId?.trim() || '' : searchParams.get('sessionId')?.trim() || '';
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('idle');
  const [viewState, setViewState] = useState<BrowserViewState | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameSequence, setFrameSequence] = useState(0);
  const [address, setAddress] = useState('about:blank');
  const [failure, setFailure] = useState<BrowserViewFailure | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceBrowserFile[]>([]);
  const [fileSearch, setFileSearch] = useState('');
  const [selectedUploadPath, setSelectedUploadPath] = useState('');
  const [filesLoading, setFilesLoading] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const connectTimeoutRef = useRef<number | null>(null);
  const intentionalCloseRef = useRef(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastPointerMoveAtRef = useRef(0);
  const autoConnectedContextRef = useRef<string | null>(null);

  const availableSessions = useMemo(
    () => sessions.filter((session) => session.engine !== 'legacy' && session.agentId === selectedAgentId),
    [selectedAgentId, sessions],
  );
  const selectedAgent = useMemo(
    () => agents.find((candidate) => candidate.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId],
  );
  const selectedSession = useMemo(
    () => sessions.find((candidate) => candidate.sessionId === selectedSessionId && candidate.agentId === selectedAgentId) ?? null,
    [selectedAgentId, selectedSessionId, sessions],
  );
  const chatHref = useMemo(() => {
    return buildChatSessionHref('/chat', selectedSessionId, selectedSession?.workspace?.workspaceId);
  }, [selectedSession, selectedSessionId]);
  const userControls = connectionStatus === 'live'
    && viewState?.mode === 'user'
    && viewState.controlOwnerViewId === viewState.viewId;

  const disconnect = useCallback((options: { preserveFailure?: boolean; preserveFrame?: boolean } = {}) => {
    intentionalCloseRef.current = true;
    if (connectTimeoutRef.current !== null) {
      window.clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) closeBrowserWebSocket(socket, 1000, 'View closed');
    setConnectionStatus('idle');
    if (!options.preserveFrame) {
      setViewState(null);
      setFrameUrl(null);
      setFrameSequence(0);
    }
    if (!options.preserveFailure) setFailure(null);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCatalogLoading(true);
      setFailure(null);
      try {
        const [agentsResponse, sessionsResponse] = await Promise.all([
          fetch('/api/agents', { credentials: 'include' }),
          fetch('/api/sessions?agentId=all', { credentials: 'include' }),
        ]);
        const agentsPayload = await agentsResponse.json() as {
          success?: boolean;
          data?: { agents?: AgentProfile[] };
          error?: string;
        };
        const sessionsPayload = await sessionsResponse.json() as {
          success?: boolean;
          sessions?: AISession[];
          error?: string;
        };
        if (!agentsResponse.ok || !agentsPayload.success) throw new Error(agentsPayload.error || 'Could not load agents.');
        if (!sessionsResponse.ok || !sessionsPayload.success) throw new Error(sessionsPayload.error || 'Could not load sessions.');
        if (cancelled) return;
        const nextAgents = agentsPayload.data?.agents ?? [];
        const nextSessions = sessionsPayload.sessions ?? [];
        const exactAgentAvailable = initialAgentId && nextAgents.some((candidate) => candidate.agentId === initialAgentId);
        if (isLiveView && !exactAgentAvailable) throw new Error(t.contextUnavailable);
        const resolvedAgentId = exactAgentAvailable ? initialAgentId : nextAgents[0]?.agentId ?? '';
        const matchingSessions = nextSessions.filter(
          (candidate) => candidate.engine !== 'legacy' && candidate.agentId === resolvedAgentId,
        );
        const exactSessionAvailable = initialSessionId
          && matchingSessions.some((candidate) => candidate.sessionId === initialSessionId);
        if (isLiveView && !exactSessionAvailable) throw new Error(t.contextUnavailable);
        const resolvedSessionId = exactSessionAvailable
          ? initialSessionId
          : matchingSessions[0]?.sessionId ?? '';
        setAgents(nextAgents);
        setSessions(nextSessions);
        setSelectedAgentId(resolvedAgentId);
        setSelectedSessionId(resolvedSessionId);
      } catch (loadError) {
        if (!cancelled) {
          setFailure({
            code: 'CONNECTION_FAILED',
            error: loadError instanceof Error ? loadError.message : t.errors.CONNECTION_FAILED,
            retryable: true,
            fatal: false,
          });
        }
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialAgentId, initialSessionId, isLiveView, t.contextUnavailable, t.errors.CONNECTION_FAILED]);

  const fileChooserOpenedAt = viewState?.pendingFileChooser?.openedAt ?? null;
  useEffect(() => {
    if (!fileChooserOpenedAt || !selectedSessionId || !selectedAgentId) {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setWorkspaceFiles([]);
        setSelectedUploadPath('');
        setFilesLoading(true);
        try {
          const query = new URLSearchParams({
            agentId: selectedAgentId,
            sessionId: selectedSessionId,
            q: fileSearch,
          });
          const response = await fetch(`/api/browser/view/files?${query}`, {
            credentials: 'include',
            signal: controller.signal,
          });
          const payload = await response.json() as {
            success?: boolean;
            data?: { files?: WorkspaceBrowserFile[] };
          };
          if (!response.ok || !payload.success) throw new Error('Workspace files are unavailable.');
          const files = payload.data?.files ?? [];
          setWorkspaceFiles(files);
          setSelectedUploadPath((current) => (
            files.some((file) => file.selectable && file.path === current)
              ? current
              : files.find((file) => file.selectable)?.path ?? ''
          ));
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return;
          setFailure(clientFailure(t, 'FILE_ACCESS_DENIED', false, false));
        } finally {
          if (!controller.signal.aborted) setFilesLoading(false);
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [fileChooserOpenedAt, fileSearch, selectedAgentId, selectedSessionId, t]);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (frameSequence > 0) send({ type: 'frame_ack', sequence: frameSequence });
  }, [frameSequence, send]);

  const connect = useCallback(async () => {
    if (!selectedAgentId || !selectedSessionId) return;
    const preserveFrame = connectionStatus === 'failed' && Boolean(frameUrl);
    disconnect({ preserveFailure: true, preserveFrame });
    intentionalCloseRef.current = false;
    setConnectionStatus('connecting');
    setFailure(null);
    try {
      const response = await fetch('/api/browser/view', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, sessionId: selectedSessionId }),
      });
      const payload = await response.json() as ViewTicketResponse;
      if (!response.ok || !payload.success || !payload.data) {
        const code = payload.code || 'CONNECTION_FAILED';
        setFailure(localizedFailure(t, {
          code,
          error: payload.error || t.errors[code],
          retryable: payload.retryable ?? true,
          fatal: payload.fatal ?? true,
        }));
        setConnectionStatus('failed');
        return;
      }
      const socket = new WebSocket(socketUrl(payload.data.websocketUrl));
      socketRef.current = socket;
      socket.addEventListener('message', (event) => {
        let message: BrowserSocketMessage;
        try {
          message = JSON.parse(String(event.data)) as BrowserSocketMessage;
        } catch {
          setFailure(clientFailure(t, 'INVALID_MESSAGE', false, true));
          setConnectionStatus('failed');
          closeBrowserWebSocket(socket, 1002, 'Invalid browser message');
          return;
        }
        if (message.type === 'auth_success') {
          socket.send(JSON.stringify({ type: 'view_subscribe', ticket: payload.data!.ticket }));
        } else if (message.type === 'ready') {
          if (connectTimeoutRef.current !== null) {
            window.clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
          }
          setFailure(null);
          setConnectionStatus('live');
        } else if (message.type === 'frame') {
          setFrameUrl(`data:${message.mimeType};base64,${message.data}`);
          setFrameSequence(message.sequence);
        } else if (message.type === 'state') {
          setViewState(message.state);
          if (message.state.url) setAddress(message.state.url);
          setFailure((current) => current?.fatal ? current : null);
        } else if (message.type === 'error') {
          setFailure(localizedFailure(t, message));
          if (message.fatal) {
            setConnectionStatus('failed');
            closeBrowserWebSocket(socket, 1011, message.code);
          }
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          if (connectTimeoutRef.current !== null) {
            window.clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
          }
          if (intentionalCloseRef.current) {
            setConnectionStatus('idle');
          } else {
            setFailure((current) => current ?? clientFailure(t, 'CONNECTION_LOST', true, true));
            setConnectionStatus('failed');
          }
        }
      });
      socket.addEventListener('error', () => {
        setFailure(clientFailure(t, 'CONNECTION_FAILED', true, true));
      });
      connectTimeoutRef.current = window.setTimeout(() => {
        if (socketRef.current !== socket) return;
        setFailure(clientFailure(t, 'CONNECTION_TIMEOUT', true, true));
        setConnectionStatus('failed');
        closeBrowserWebSocket(socket, 4000, 'Connection timeout');
      }, 15_000);
    } catch (connectError) {
      setConnectionStatus('failed');
      setFailure({
        ...clientFailure(t, 'CONNECTION_FAILED', true, true),
        error: connectError instanceof Error ? connectError.message : t.errors.CONNECTION_FAILED,
      });
    }
  }, [connectionStatus, disconnect, frameUrl, selectedAgentId, selectedSessionId, t]);

  useEffect(() => {
    if (!isLiveView || catalogLoading || !selectedAgentId || !selectedSessionId) return;
    const contextKey = `${selectedAgentId}:${selectedSessionId}`;
    if (autoConnectedContextRef.current === contextKey) return;
    autoConnectedContextRef.current = contextKey;
    void connect();
  }, [catalogLoading, connect, isLiveView, selectedAgentId, selectedSessionId]);

  useEffect(() => {
    if (connectionStatus !== 'live') return;
    const timer = window.setInterval(() => send({ type: 'heartbeat' }), 10_000);
    return () => window.clearInterval(timer);
  }, [connectionStatus, send]);

  const requestControl = useCallback((mode: BrowserViewControlMode) => {
    send({ type: 'control_request', mode });
  }, [send]);

  const scaledPoint = useCallback((event: PointerEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const viewport = viewState?.viewport;
    if (!viewport || bounds.width <= 0 || bounds.height <= 0) return null;
    return {
      x: (event.clientX - bounds.left) * viewport.width / bounds.width,
      y: (event.clientY - bounds.top) * viewport.height / bounds.height,
    };
  }, [viewState?.viewport]);

  const handlePointerDown = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (!userControls) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = scaledPoint(event);
    if (point) send({ type: 'input_mouse', action: 'down', ...point, button: mouseButton(event.button) });
  }, [scaledPoint, send, userControls]);

  const handlePointerMove = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (!userControls || event.buttons === 0) return;
    const now = performance.now();
    if (now - lastPointerMoveAtRef.current < 32) return;
    lastPointerMoveAtRef.current = now;
    const point = scaledPoint(event);
    if (point) send({ type: 'input_mouse', action: 'move', ...point, button: mouseButton(event.button) });
  }, [scaledPoint, send, userControls]);

  const handlePointerUp = useCallback((event: PointerEvent<HTMLImageElement>) => {
    if (!userControls) return;
    event.preventDefault();
    const point = scaledPoint(event);
    if (point) send({ type: 'input_mouse', action: 'up', ...point, button: mouseButton(event.button) });
  }, [scaledPoint, send, userControls]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLImageElement>) => {
    if (!userControls || event.nativeEvent.isComposing) return;
    if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return;
    event.preventDefault();
    const modifiers = [
      ...(event.altKey ? ['Alt'] : []),
      ...(event.ctrlKey ? ['Control'] : []),
      ...(event.metaKey ? ['Meta'] : []),
      ...(event.shiftKey ? ['Shift'] : []),
    ];
    const printable = event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey;
    send({ type: 'input_key', key: event.key === ' ' ? 'Space' : event.key, text: printable ? event.key : undefined, modifiers });
  }, [send, userControls]);

  const handleWheel = useCallback((event: WheelEvent<HTMLImageElement>) => {
    if (!userControls) return;
    event.preventDefault();
    send({ type: 'input_scroll', deltaX: event.deltaX, deltaY: event.deltaY });
  }, [send, userControls]);

  const navigate = useCallback((event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) send({ type: 'navigate', url: address.trim() });
  }, [address, send]);

  const modeLabel = viewState?.mode === 'user' ? t.modeUser : viewState?.mode === 'view' ? t.modeView : t.modeAgent;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[radial-gradient(circle_at_20%_0%,hsl(var(--primary)/0.09),transparent_32%),hsl(var(--background))]">
      <section className="shrink-0 border-b border-border/70 px-4 py-4 md:px-6">
        <div className="mx-auto flex max-w-[1600px] flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.22em] text-primary">
              <CircleDot className="h-3.5 w-3.5" />
              {isLiveView ? t.liveEyebrow : t.eyebrow}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{isLiveView ? t.liveTitle : t.title}</h2>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
              {isLiveView ? t.liveDescription : t.description}
            </p>
          </div>

          {isLiveView ? (
            <div className="flex min-w-0 flex-col gap-3 sm:items-end">
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                <span className="inline-flex min-w-0 items-center gap-2 rounded-md border border-border/70 bg-background/70 px-3 py-2 text-foreground">
                  <Bot className="h-4 w-4 shrink-0 text-primary" />
                  <span className="max-w-40 truncate font-medium">{selectedAgent?.name || t.agent}</span>
                  <span className="text-muted-foreground">·</span>
                  <span className="max-w-64 truncate text-muted-foreground">{selectedSession?.title || t.currentChat}</span>
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="outline" className="h-10 gap-2">
                  <Link href={chatHref}>
                    <ArrowLeft className="h-4 w-4" />
                    {t.backToChat}
                  </Link>
                </Button>
                <Button
                  className="h-10 gap-2"
                  disabled={!selectedSessionId || catalogLoading || connectionStatus === 'connecting'}
                  onClick={() => void connect()}
                >
                  {connectionStatus === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorUp className="h-4 w-4" />}
                  {connectionStatus === 'live' || connectionStatus === 'failed' ? t.reconnect : t.connect}
                </Button>
                {connectionStatus === 'live' ? (
                  <Button variant="outline" size="icon" className="h-10 w-10" onClick={() => disconnect()} title={t.disconnect}>
                    <Unplug className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(180px,240px)_minmax(240px,360px)_auto]">
              <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
                <span>{t.agent}</span>
                <select
                  value={selectedAgentId}
                  disabled={catalogLoading || connectionStatus === 'connecting' || connectionStatus === 'live'}
                  onChange={(event) => {
                    disconnect();
                    const nextAgentId = event.target.value;
                    setSelectedAgentId(nextAgentId);
                    setSelectedSessionId(
                      sessions.find((candidate) => candidate.engine !== 'legacy' && candidate.agentId === nextAgentId)?.sessionId ?? '',
                    );
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  {agents.map((candidate) => <option key={candidate.agentId} value={candidate.agentId}>{candidate.name}</option>)}
                </select>
              </label>
              <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
                <span>{t.session}</span>
                <select
                  value={selectedSessionId}
                  disabled={catalogLoading || connectionStatus === 'connecting' || connectionStatus === 'live' || availableSessions.length === 0}
                  onChange={(event) => {
                    disconnect();
                    setSelectedSessionId(event.target.value);
                  }}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                >
                  <option value="">{availableSessions.length ? t.chooseSession : t.noSessions}</option>
                  {availableSessions.map((candidate) => (
                    <option key={candidate.sessionId} value={candidate.sessionId}>{candidate.title || candidate.sessionId}</option>
                  ))}
                </select>
              </label>
              <div className="flex items-end gap-2">
                {selectedSessionId ? (
                  <Button asChild variant="outline" className="h-10 gap-2">
                    <Link href={chatHref}>
                      <MessageSquare className="h-4 w-4" />
                      {t.openChat}
                    </Link>
                  </Button>
                ) : (
                  <Button variant="outline" className="h-10 gap-2" disabled>
                    <MessageSquare className="h-4 w-4" />
                    {t.openChat}
                  </Button>
                )}
                <Button
                  className="h-10 gap-2"
                  disabled={!selectedSessionId || catalogLoading || connectionStatus === 'connecting'}
                  onClick={() => void connect()}
                >
                  {connectionStatus === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorUp className="h-4 w-4" />}
                  {connectionStatus === 'live' || connectionStatus === 'failed' ? t.reconnect : t.connect}
                </Button>
                {connectionStatus === 'live' ? (
                  <Button variant="outline" size="icon" className="h-10 w-10" onClick={() => disconnect()} title={t.disconnect}>
                    <Unplug className="h-4 w-4" />
                  </Button>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 grid-rows-[minmax(430px,1fr)_auto] gap-0 overflow-y-auto xl:grid-cols-[minmax(0,1fr)_300px] xl:grid-rows-1 xl:overflow-hidden">
        <main className="flex min-h-[430px] min-w-0 flex-col border-border/70 xl:min-h-0 xl:border-r">
          <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/70 bg-muted/25 px-3">
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto py-1.5">
              {(viewState?.tabs ?? []).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  disabled={!userControls}
                  onClick={() => send({ type: 'tab_select', tabId: tab.id })}
                  className={cn(
                    'flex h-8 min-w-[150px] max-w-[240px] items-center gap-2 rounded-md border px-2.5 text-left text-xs transition-colors',
                    tab.active ? 'border-border bg-background text-foreground shadow-sm' : 'border-transparent text-muted-foreground hover:bg-background/60',
                    !userControls && 'cursor-default',
                  )}
                >
                  <Globe2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{tab.title || tab.url || 'New tab'}</span>
                </button>
              ))}
            </div>
            <Badge variant={viewState?.mode === 'user' ? 'default' : 'secondary'} className="shrink-0 gap-1.5">
              {viewState?.mode === 'user' ? <UserRound className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
              {modeLabel}
            </Badge>
          </div>

          <div className="shrink-0 border-b border-border/70 bg-background/70 p-2.5">
            <div className="flex flex-col gap-2 lg:flex-row">
              <form onSubmit={navigate} className="flex min-w-0 flex-1 gap-2">
                <div className="relative min-w-0 flex-1">
                  <Globe2 className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    aria-label={t.address}
                    value={address}
                    disabled={!userControls}
                    onChange={(event) => setAddress(event.target.value)}
                    className="h-9 pl-9 font-mono text-xs"
                  />
                </div>
                <Button type="submit" size="sm" variant="outline" disabled={!userControls} className="h-9 gap-2">
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t.navigate}
                </Button>
              </form>
              <div className="flex gap-1.5">
                <Button size="sm" variant={viewState?.mode === 'view' ? 'secondary' : 'ghost'} disabled={!viewState} onClick={() => requestControl('view')} className="h-9 gap-2">
                  <SquareMousePointer className="h-3.5 w-3.5" /> {t.viewOnly}
                </Button>
                <Button size="sm" variant={viewState?.mode === 'agent' ? 'secondary' : 'ghost'} disabled={!viewState} onClick={() => requestControl('agent')} className="h-9 gap-2">
                  <Bot className="h-3.5 w-3.5" /> {t.giveAgent}
                </Button>
                <Button size="sm" variant={userControls ? 'default' : 'outline'} disabled={!viewState} onClick={() => requestControl('user')} className="h-9 gap-2">
                  <Hand className="h-3.5 w-3.5" /> {t.takeControl}
                </Button>
              </div>
            </div>
          </div>

          {viewState?.pendingDialog ? (
            <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <ShieldAlert className="h-4 w-4 text-amber-600" />
              <span className="font-medium">{t.dialog}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{viewState.pendingDialog.message}</span>
              <Button size="sm" variant="ghost" disabled={!userControls} onClick={() => send({ type: 'dialog_resolve', accept: false })}>{t.dismiss}</Button>
              <Button size="sm" disabled={!userControls} onClick={() => send({ type: 'dialog_resolve', accept: true })}>{t.accept}</Button>
            </div>
          ) : null}

          {viewState?.pendingFileChooser ? (
            <div className="shrink-0 border-b border-primary/25 bg-primary/5 px-3 py-3">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <FileUp className="h-4 w-4 text-primary" />
                    {t.uploadTitle}
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.uploadDescription}</p>
                </div>
                <label className="min-w-0 space-y-1 text-xs text-muted-foreground lg:w-56">
                  <span>{t.searchWorkspace}</span>
                  <Input
                    value={fileSearch}
                    onChange={(event) => setFileSearch(event.target.value)}
                    className="h-8 bg-background"
                  />
                </label>
                <label className="min-w-0 space-y-1 text-xs text-muted-foreground lg:w-72">
                  <span>{filesLoading ? t.loadingFiles : t.chooseFile}</span>
                  <select
                    aria-label={t.chooseFile}
                    value={selectedUploadPath}
                    disabled={filesLoading || workspaceFiles.length === 0}
                    onChange={(event) => setSelectedUploadPath(event.target.value)}
                    className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
                  >
                    {workspaceFiles.length === 0 ? <option value="">{t.noFiles}</option> : null}
                    {workspaceFiles.map((file) => (
                      <option key={file.path} value={file.path} disabled={!file.selectable}>
                        {file.path} · {formatBytes(file.size)}{file.selectable ? '' : ' · max 100 MiB'}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => send({ type: 'file_cancel' })}
                  >
                    {t.cancelFileChooser}
                  </Button>
                  <Button
                    size="sm"
                    className="h-8 gap-1.5"
                    disabled={!selectedUploadPath || filesLoading}
                    onClick={() => send({ type: 'file_upload', paths: [selectedUploadPath] })}
                  >
                    <FileUp className="h-3.5 w-3.5" />
                    {t.uploadSelected}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {viewState?.sensitiveInputFocused ? (
            <div className="flex shrink-0 items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium text-foreground">{t.sensitiveTitle}</p>
                <p className="mt-0.5 leading-5 text-muted-foreground">{t.sensitiveDescription}</p>
              </div>
            </div>
          ) : null}

          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#11130f] p-3 md:p-5">
            <div className="pointer-events-none absolute inset-0 opacity-30 [background-image:linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] [background-size:24px_24px]" />
            {frameUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={imageRef}
                src={frameUrl}
                alt={viewState?.title || 'Live browser'}
                draggable={false}
                tabIndex={userControls ? 0 : -1}
                onContextMenu={(event) => event.preventDefault()}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onKeyDown={handleKeyDown}
                onWheel={handleWheel}
                className={cn(
                  'relative max-h-full max-w-full select-none rounded-lg border border-white/10 bg-white shadow-[0_32px_100px_-28px_rgba(0,0,0,.9)] outline-none',
                  userControls ? 'cursor-default focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-[#11130f]' : 'cursor-not-allowed',
                )}
              />
            ) : (
              <div className="relative max-w-sm text-center text-white/80">
                {connectionStatus === 'connecting'
                  ? <Loader2 className="mx-auto mb-5 h-9 w-9 animate-spin text-primary" />
                  : connectionStatus === 'failed'
                    ? <ShieldAlert className="mx-auto mb-5 h-9 w-9 text-amber-400" />
                    : <Globe2 className="mx-auto mb-5 h-9 w-9 text-white/35" />}
                <h3 className="text-lg font-semibold">
                  {connectionStatus === 'connecting' ? t.loading : connectionStatus === 'failed' ? t.failureTitle : t.emptyTitle}
                </h3>
                <p className="mt-2 text-sm leading-6 text-white/45">
                  {connectionStatus === 'connecting' ? t.connecting : connectionStatus === 'failed' ? t.failureDescription : t.emptyDescription}
                </p>
              </div>
            )}
            {frameUrl && connectionStatus === 'failed' ? (
              <div className="absolute inset-x-3 bottom-3 z-10 rounded-lg border border-amber-300/20 bg-[#171912]/90 p-3 text-left text-xs text-white/80 shadow-2xl backdrop-blur md:inset-x-5 md:bottom-5">
                <div className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="font-medium text-white">{t.failureTitle}</p>
                    <p className="mt-1 leading-5 text-white/55">{t.failureDescription}</p>
                  </div>
                </div>
              </div>
            ) : null}
            {frameUrl && userControls ? (
              <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 text-[11px] text-white/70 backdrop-blur">
                <SquareMousePointer className="h-3.5 w-3.5" /> {t.inputHint}
              </div>
            ) : null}
          </div>

          {failure ? (
            <div role="alert" aria-live="polite" className="flex shrink-0 flex-wrap items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span className="min-w-[220px] flex-1">{failure.error}</span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2"
                onClick={() => {
                  if (connectionStatus === 'failed' && failure.retryable) void connect();
                  else setFailure(null);
                }}
              >
                {connectionStatus === 'failed' && failure.retryable ? <RefreshCw className="h-3.5 w-3.5" /> : null}
                {connectionStatus === 'failed' && failure.retryable ? t.retry : t.dismissError}
              </Button>
            </div>
          ) : null}
        </main>

        <aside className="min-h-0 overflow-y-auto bg-muted/15 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {isLiveView ? t.context : t.diagnostics}
            </h3>
            <span className={cn(
              'h-2 w-2 rounded-full',
              connectionStatus === 'live'
                ? 'bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,.8)]'
                : connectionStatus === 'connecting'
                  ? 'animate-pulse bg-amber-500'
                  : connectionStatus === 'failed'
                    ? 'bg-destructive shadow-[0_0_12px_hsl(var(--destructive)/.6)]'
                    : 'bg-muted-foreground/40',
            )} />
          </div>
          {isLiveView ? (
            <div className="space-y-2 text-xs">
              <div className="rounded-lg border border-border/70 bg-background/65 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.status}</div>
                <div className="mt-1.5 font-medium text-foreground" aria-live="polite">
                  {connectionStatus === 'live' ? t.live : connectionStatus === 'connecting' ? t.connecting : connectionStatus === 'failed' ? t.failed : t.disconnected}
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/65 p-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{selectedAgent?.name || t.agent}</div>
                    <div className="mt-0.5 truncate text-muted-foreground">{selectedSession?.title || t.currentChat}</div>
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-border/70 bg-background/65 p-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{t.tabs}</div>
                <div className="mt-1.5 font-medium text-foreground">{String(viewState?.tabs.length ?? 0)}</div>
              </div>
            </div>
          ) : (
            <dl className="space-y-3 text-xs">
              <DiagnosticRow label={t.status} value={connectionStatus === 'live' ? t.live : connectionStatus === 'connecting' ? t.connecting : connectionStatus === 'failed' ? t.failed : t.disconnected} />
              <DiagnosticRow label={t.agent} value={viewState?.agentId || selectedAgentId || '—'} mono />
              <DiagnosticRow label={t.session} value={viewState?.agentSessionId || selectedSessionId || '—'} mono />
              <DiagnosticRow label={t.workspace} value={viewState?.workspaceId || '—'} mono />
              <DiagnosticRow label={t.viewport} value={viewState ? `${viewState.viewport.width} × ${viewState.viewport.height}` : '—'} />
              <DiagnosticRow label={t.frameRate} value={viewState ? `${viewState.resourceBudget.fps} FPS` : '—'} />
              <DiagnosticRow label={t.memory} value={viewState ? `${viewState.resourceBudget.effectiveMemoryMb} MiB` : '—'} />
              <DiagnosticRow label={t.availableMemory} value={viewState ? `${viewState.resourceBudget.availableMemoryMb} MiB` : '—'} />
              <DiagnosticRow label={t.tabs} value={String(viewState?.tabs.length ?? 0)} />
            </dl>
          )}

          <div className="mt-6 rounded-lg border border-border/70 bg-background/65 p-3">
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>{t.privateNotice}</span>
            </div>
          </div>
          {(viewState?.downloads.length ?? 0) > 0 ? (
            <div className="mt-3 rounded-lg border border-border/70 bg-background/65 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
                <Download className="h-3.5 w-3.5 text-primary" />
                {t.downloads}
              </div>
              <div className="space-y-2">
                {viewState?.downloads.map((download) => (
                  <div key={download.id} className="min-w-0 border-t border-border/60 pt-2 first:border-0 first:pt-0">
                    <div className="truncate text-xs font-medium text-foreground">{download.fileName}</div>
                    <div className="mt-0.5 text-[11px] text-muted-foreground">
                      {download.status === 'completed' && download.workspacePath
                        ? (
                          <a
                            className="text-primary underline-offset-2 hover:underline"
                            href={`/api/files/download?workspaceId=${encodeURIComponent(viewState.workspaceId)}&path=${encodeURIComponent(download.workspacePath)}`}
                          >
                            {t.downloadReady} · {formatBytes(download.receivedBytes)}
                          </a>
                        )
                        : download.status === 'in_progress'
                          ? `${t.downloadInProgress} · ${formatBytes(download.receivedBytes)}${download.totalBytes > 0 ? ` / ${formatBytes(download.totalBytes)}` : ''}`
                          : t.downloadFailed}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {viewState?.mode !== 'user' ? (
            <div className="mt-3 rounded-lg border border-border/70 p-3 text-xs leading-5 text-muted-foreground">
              <div className="mb-1.5 flex items-center gap-2 font-medium text-foreground"><ArrowLeftRight className="h-3.5 w-3.5" />{t.takeControl}</div>
              {t.takeoverWarning}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function DiagnosticRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="space-y-1 border-b border-border/60 pb-3 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('break-all font-medium text-foreground', mono && 'font-mono text-[11px]')}>{value}</dd>
    </div>
  );
}
