'use client';

import {
  ArrowLeftRight,
  Bot,
  CircleDot,
  ExternalLink,
  Globe2,
  Hand,
  Loader2,
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
import type { BrowserViewControlMode, BrowserViewState } from '@/app/lib/pi/browser/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

type BrowserLabClientProps = {
  locale: string;
};

type ViewTicketResponse = {
  success?: boolean;
  error?: string;
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
  | { type: 'error'; code: string; error: string };

const copy = {
  de: {
    eyebrow: 'Entwicklungswerkzeug',
    title: 'Browser Lab',
    description: 'Dieselbe Chromium-Seite beobachten und steuern, die der Agent in seiner Session verwendet.',
    agent: 'Agent',
    session: 'Chat-Session',
    chooseSession: 'Session auswählen',
    noSessions: 'Keine PI-Chat-Session für diesen Agenten vorhanden.',
    connect: 'Live-Ansicht starten',
    reconnect: 'Neu verbinden',
    disconnect: 'Trennen',
    loading: 'Browser-Ansicht wird vorbereitet …',
    disconnected: 'Nicht verbunden',
    connecting: 'Verbindung wird aufgebaut',
    live: 'Live verbunden',
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
    accept: 'Bestätigen',
    dismiss: 'Abbrechen',
    privateNotice: 'Eingaben werden live an Chromium gesendet und nicht protokolliert.',
  },
  en: {
    eyebrow: 'Development tool',
    title: 'Browser Lab',
    description: 'Observe and control the same Chromium page used by the agent in its session.',
    agent: 'Agent',
    session: 'Chat session',
    chooseSession: 'Choose a session',
    noSessions: 'No PI chat session exists for this agent.',
    connect: 'Start live view',
    reconnect: 'Reconnect',
    disconnect: 'Disconnect',
    loading: 'Preparing browser view…',
    disconnected: 'Disconnected',
    connecting: 'Connecting',
    live: 'Live connected',
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
    accept: 'Accept',
    dismiss: 'Dismiss',
    privateNotice: 'Input is sent live to Chromium and is not logged.',
  },
} as const;

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

export function BrowserLabClient({ locale }: BrowserLabClientProps) {
  const t = locale === 'en' ? copy.en : copy.de;
  const searchParams = useSearchParams();
  const initialAgentId = searchParams.get('agentId')?.trim() || '';
  const initialSessionId = searchParams.get('sessionId')?.trim() || '';
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<AISession[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState(initialAgentId);
  const [selectedSessionId, setSelectedSessionId] = useState(initialSessionId);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'connecting' | 'live'>('idle');
  const [viewState, setViewState] = useState<BrowserViewState | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [frameSequence, setFrameSequence] = useState(0);
  const [address, setAddress] = useState('about:blank');
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const lastPointerMoveAtRef = useRef(0);

  const availableSessions = useMemo(
    () => sessions.filter((session) => session.engine !== 'legacy' && session.agentId === selectedAgentId),
    [selectedAgentId, sessions],
  );
  const userControls = viewState?.mode === 'user' && viewState.controlOwnerViewId === viewState.viewId;

  const disconnect = useCallback(() => {
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'View closed');
    setConnectionStatus('idle');
    setViewState(null);
    setFrameUrl(null);
    setFrameSequence(0);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setCatalogLoading(true);
      setError(null);
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
        const resolvedAgentId = initialAgentId && nextAgents.some((agent) => agent.agentId === initialAgentId)
          ? initialAgentId
          : nextAgents[0]?.agentId ?? '';
        const matchingSessions = nextSessions.filter(
          (candidate) => candidate.engine !== 'legacy' && candidate.agentId === resolvedAgentId,
        );
        const resolvedSessionId = initialSessionId
          && matchingSessions.some((candidate) => candidate.sessionId === initialSessionId)
          ? initialSessionId
          : matchingSessions[0]?.sessionId ?? '';
        setAgents(nextAgents);
        setSessions(nextSessions);
        setSelectedAgentId(resolvedAgentId);
        setSelectedSessionId(resolvedSessionId);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : 'Could not load Browser Lab.');
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [initialAgentId, initialSessionId]);

  const send = useCallback((message: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (frameSequence > 0) send({ type: 'frame_ack', sequence: frameSequence });
  }, [frameSequence, send]);

  const connect = useCallback(async () => {
    if (!selectedAgentId || !selectedSessionId) return;
    disconnect();
    setConnectionStatus('connecting');
    setError(null);
    try {
      const response = await fetch('/api/browser/view', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: selectedAgentId, sessionId: selectedSessionId }),
      });
      const payload = await response.json() as ViewTicketResponse;
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || 'Could not start browser view.');
      }
      const socket = new WebSocket(socketUrl(payload.data.websocketUrl));
      socketRef.current = socket;
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data)) as BrowserSocketMessage;
        if (message.type === 'auth_success') {
          socket.send(JSON.stringify({ type: 'view_subscribe', ticket: payload.data!.ticket }));
        } else if (message.type === 'ready') {
          setConnectionStatus('live');
        } else if (message.type === 'frame') {
          setFrameUrl(`data:${message.mimeType};base64,${message.data}`);
          setFrameSequence(message.sequence);
        } else if (message.type === 'state') {
          setViewState(message.state);
          if (message.state.url) setAddress(message.state.url);
        } else if (message.type === 'error') {
          setError(message.error);
        }
      });
      socket.addEventListener('close', () => {
        if (socketRef.current === socket) {
          socketRef.current = null;
          setConnectionStatus('idle');
        }
      });
      socket.addEventListener('error', () => setError('Browser WebSocket connection failed.'));
    } catch (connectError) {
      setConnectionStatus('idle');
      setError(connectError instanceof Error ? connectError.message : 'Could not start browser view.');
    }
  }, [disconnect, selectedAgentId, selectedSessionId]);

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
              {t.eyebrow}
            </div>
            <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">{t.title}</h2>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">{t.description}</p>
          </div>

          <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(180px,240px)_minmax(240px,360px)_auto]">
            <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{t.agent}</span>
              <select
                value={selectedAgentId}
                disabled={catalogLoading || connectionStatus !== 'idle'}
                onChange={(event) => {
                  const nextAgentId = event.target.value;
                  setSelectedAgentId(nextAgentId);
                  setSelectedSessionId(
                    sessions.find((candidate) => candidate.engine !== 'legacy' && candidate.agentId === nextAgentId)?.sessionId ?? '',
                  );
                }}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {agents.map((agent) => <option key={agent.agentId} value={agent.agentId}>{agent.name}</option>)}
              </select>
            </label>
            <label className="min-w-0 space-y-1.5 text-xs font-medium text-muted-foreground">
              <span>{t.session}</span>
              <select
                value={selectedSessionId}
                disabled={catalogLoading || connectionStatus !== 'idle' || availableSessions.length === 0}
                onChange={(event) => setSelectedSessionId(event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                <option value="">{availableSessions.length ? t.chooseSession : t.noSessions}</option>
                {availableSessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>{session.title || session.sessionId}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button
                className="h-10 gap-2"
                disabled={!selectedSessionId || catalogLoading || connectionStatus === 'connecting'}
                onClick={() => void connect()}
              >
                {connectionStatus === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <MonitorUp className="h-4 w-4" />}
                {connectionStatus === 'live' ? t.reconnect : t.connect}
              </Button>
              {connectionStatus === 'live' ? (
                <Button variant="outline" size="icon" className="h-10 w-10" onClick={disconnect} title={t.disconnect}>
                  <Unplug className="h-4 w-4" />
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <div className="mx-auto grid min-h-0 w-full max-w-[1600px] flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_300px]">
        <main className="flex min-h-0 min-w-0 flex-col border-border/70 xl:border-r">
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
                {connectionStatus === 'connecting' ? <Loader2 className="mx-auto mb-5 h-9 w-9 animate-spin text-primary" /> : <Globe2 className="mx-auto mb-5 h-9 w-9 text-white/35" />}
                <h3 className="text-lg font-semibold">{connectionStatus === 'connecting' ? t.loading : t.emptyTitle}</h3>
                <p className="mt-2 text-sm leading-6 text-white/45">{connectionStatus === 'connecting' ? t.connecting : t.emptyDescription}</p>
              </div>
            )}
            {frameUrl && userControls ? (
              <div className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/10 bg-black/70 px-3 py-1.5 text-[11px] text-white/70 backdrop-blur">
                <SquareMousePointer className="h-3.5 w-3.5" /> {t.inputHint}
              </div>
            ) : null}
          </div>

          {error ? (
            <div role="alert" className="flex shrink-0 items-center gap-2 border-t border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1">{error}</span>
              <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setError(null)}><RefreshCw className="h-3.5 w-3.5" /></Button>
            </div>
          ) : null}
        </main>

        <aside className="min-h-0 overflow-y-auto bg-muted/15 p-4">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t.diagnostics}</h3>
            <span className={cn('h-2 w-2 rounded-full', connectionStatus === 'live' ? 'bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,.8)]' : connectionStatus === 'connecting' ? 'animate-pulse bg-amber-500' : 'bg-muted-foreground/40')} />
          </div>
          <dl className="space-y-3 text-xs">
            <DiagnosticRow label="Status" value={connectionStatus === 'live' ? t.live : connectionStatus === 'connecting' ? t.connecting : t.disconnected} />
            <DiagnosticRow label={t.agent} value={viewState?.agentId || selectedAgentId || '—'} mono />
            <DiagnosticRow label={t.session} value={viewState?.agentSessionId || selectedSessionId || '—'} mono />
            <DiagnosticRow label={t.workspace} value={viewState?.workspaceId || '—'} mono />
            <DiagnosticRow label={t.viewport} value={viewState ? `${viewState.viewport.width} × ${viewState.viewport.height}` : '—'} />
            <DiagnosticRow label={t.frameRate} value={viewState ? `${viewState.resourceBudget.fps} FPS` : '—'} />
            <DiagnosticRow label={t.memory} value={viewState ? `${viewState.resourceBudget.effectiveMemoryMb} MiB` : '—'} />
            <DiagnosticRow label={t.availableMemory} value={viewState ? `${viewState.resourceBudget.availableMemoryMb} MiB` : '—'} />
            <DiagnosticRow label={t.tabs} value={String(viewState?.tabs.length ?? 0)} />
          </dl>

          <div className="mt-6 rounded-lg border border-border/70 bg-background/65 p-3">
            <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>{t.privateNotice}</span>
            </div>
          </div>
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
