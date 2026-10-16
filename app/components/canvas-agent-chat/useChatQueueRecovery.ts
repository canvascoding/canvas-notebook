'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatQueueRecoveryStatus } from '@/app/lib/chat/queue-recovery';
import type { RuntimeQueueItem, RuntimeStatus } from '@/app/lib/chat/runtime-status';
import { openedDocumentAuthScope, isOpenedDocumentAuthCurrent, subscribeOpenedDocumentAuthInvalidation } from '@/app/lib/collaboration/opened-document-registry';

const POLL_DELAYS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];
type State = { token: symbol; queue: ChatQueueRecoveryStatus | null; loading: boolean; readError: string | null; actionError: string | null; pendingId: string | null };
type Frame = { token: symbol; sequence: number; queue: ChatQueueRecoveryStatus | null; read: AbortController | null;
  readFailed: boolean; mutation: AbortController | null; poll: ReturnType<typeof setTimeout> | null; polls: number };
type Params = { sessionId: string | null; workspaceId: string | null; connected: boolean; runtimeStatus: RuntimeStatus | null;
  onRuntimeStatus: (status: RuntimeStatus) => void };

function readQueue(value: unknown, sessionId: string): ChatQueueRecoveryStatus {
  if (!value || typeof value !== 'object') throw new Error('The queue response is invalid.');
  const queue = value as ChatQueueRecoveryStatus;
  if (queue.sessionId !== sessionId || !Array.isArray(queue.items) || !Array.isArray(queue.blocked)
    || queue.items.some(item => !item || typeof item.id !== 'string' || !item.id || typeof item.text !== 'string'
      || typeof item.clientMessageId !== 'string' || !item.clientMessageId || !Number.isSafeInteger(item.executionRevision) || item.executionRevision! < 1
      || item.queue !== null && (!item.queue || !['prompt', 'follow_up', 'steer'].includes(item.queue.lane)
        || !Number.isSafeInteger(item.queue.ordinal) || item.queue.ordinal < 1 || !['ready', 'suspended'].includes(item.queue.disposition)))
    || queue.blocked.some(item => !item || typeof item.clientMessageId !== 'string'
      || !['legacy', 'unknown_queue_position', 'outcome_unknown', 'execution_in_progress'].includes(item.reason)))
    throw new Error('The queue response does not match this chat.');
  return queue;
}

/** Read-only polling never resumes a message. Every mutation is one explicit user action. */
export function useChatQueueRecovery({ sessionId, workspaceId, connected, runtimeStatus, onRuntimeStatus }: Params) {
  const auth = useSyncExternalStore(subscribeOpenedDocumentAuthInvalidation, openedDocumentAuthScope, () => null);
  const scope = JSON.stringify([auth?.userId, auth?.sessionId, auth?.epoch, workspaceId, sessionId]);
  const token = useMemo(() => Symbol(scope), [scope]);
  const active = useRef<Frame | null>(null), applyStatus = useRef(onRuntimeStatus);
  const [state, setState] = useState<State | null>(null);
  useLayoutEffect(() => { applyStatus.current = onRuntimeStatus; }, [onRuntimeStatus]);
  useLayoutEffect(() => {
    const frame: Frame = { token, sequence: 0, queue: null, read: null, readFailed: true, mutation: null, poll: null, polls: 0 };
    active.current = frame;
    return () => { if (frame.poll) clearTimeout(frame.poll); frame.read?.abort(); frame.mutation?.abort(); if (active.current === frame) active.current = null; };
  }, [token]);
  const isCurrent = useCallback((frame: Frame) => active.current === frame && frame.token === token
    && isOpenedDocumentAuthCurrent(auth), [auth, token]);

  const read = useCallback(async (frame: Frame): Promise<void> => {
    if (!sessionId || !workspaceId || !isCurrent(frame) || frame.mutation) return;
    if (frame.poll) { clearTimeout(frame.poll); frame.poll = null; }
    frame.read?.abort(); const controller = new AbortController(), sequence = ++frame.sequence; frame.read = controller;
    setState(previous => ({ token, queue: frame.queue, loading: true, readError: null,
      actionError: previous?.token === token ? previous.actionError : null, pendingId: null }));
    let failed = false;
    try {
      const response = await fetch(`/api/chat/queue?${new URLSearchParams({ sessionId })}`, { credentials: 'include', cache: 'no-store',
        headers: { 'X-Canvas-Workspace-Id': workspaceId }, signal: controller.signal });
      const payload = await response.json() as { success?: boolean; queue?: unknown; error?: string };
      if (!response.ok || payload.success !== true) throw new Error(payload.error || 'The queue could not be read.');
      const queue = readQueue(payload.queue, sessionId);
      if (!isCurrent(frame) || controller.signal.aborted || sequence !== frame.sequence) return;
      frame.queue = queue; frame.readFailed = false;
      setState(previous => ({ token, queue, loading: false, readError: null,
        actionError: previous?.token === token ? previous.actionError : null, pendingId: null }));
    } catch (error) {
      if (!isCurrent(frame) || controller.signal.aborted || sequence !== frame.sequence) return;
      failed = true; frame.readFailed = true;
      setState(previous => ({ token, queue: frame.queue, loading: false, readError: error instanceof Error ? error.message : String(error),
        actionError: previous?.token === token ? previous.actionError : null, pendingId: null }));
    } finally {
      if (frame.read === controller) frame.read = null;
      if (isCurrent(frame) && !controller.signal.aborted && sequence === frame.sequence
        && (failed || frame.queue?.blocked.length || frame.queue?.items.length) && frame.polls < POLL_DELAYS.length) {
        const delay = POLL_DELAYS[frame.polls++]; frame.poll = setTimeout(() => { frame.poll = null; void read(frame); }, delay);
      }
    }
  }, [isCurrent, sessionId, token, workspaceId]);

  const refresh = useCallback(() => {
    const frame = active.current;
    if (!frame || !isCurrent(frame)) return Promise.resolve();
    frame.polls = 0;
    setState(previous => previous?.token === token ? { ...previous, actionError: null } : previous);
    return read(frame);
  }, [isCurrent, read, token]);
  const queueSignal = JSON.stringify([runtimeStatus?.sessionId, runtimeStatus?.phase,
    runtimeStatus?.followUpQueue.map(item => [item.id, item.executionRevision, item.queue]),
    runtimeStatus?.steeringQueue.map(item => [item.id, item.executionRevision, item.queue])]);
  useEffect(() => { const frame = active.current; if (frame) { frame.polls = 0; void read(frame); } }, [connected, queueSignal, read]);

  const control = useCallback(async (item: RuntimeQueueItem, action: 'resume' | 'cancel') => {
    const frame = active.current;
    if (!frame || !isCurrent(frame) || !sessionId || !workspaceId || frame.mutation || frame.read || frame.readFailed || !frame.queue?.items.includes(item)
      || !Number.isSafeInteger(item.executionRevision)) {
      const error = new Error('The selected queue entry changed. Refresh this chat.');
      if (frame && isCurrent(frame)) setState(previous => previous?.token === token ? { ...previous, actionError: error.message } : previous);
      throw error;
    }
    const queueItemId = item.id, executionRevision = item.executionRevision;
    if (frame.queue.blocked.some(blocker => blocker.reason !== 'unknown_queue_position'
      && (action === 'resume' || blocker.clientMessageId === item.clientMessageId))) {
      const error = new Error('The earlier execution has an unresolved outcome. Start a new chat.');
      setState(previous => previous?.token === token ? { ...previous, actionError: error.message } : previous);
      throw error;
    }
    frame.sequence++; if (frame.poll) { clearTimeout(frame.poll); frame.poll = null; }
    const controller = new AbortController(); frame.mutation = controller;
    setState(previous => ({ token, queue: frame.queue, loading: false, readError: previous?.token === token ? previous.readError : null,
      actionError: null, pendingId: queueItemId }));
    try {
      const response = await fetch('/api/chat/queue', { method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Canvas-Workspace-Id': workspaceId }, signal: controller.signal,
        body: JSON.stringify({ sessionId, action, queueItemId, executionRevision }) });
      const payload = await response.json() as { success?: boolean; queue?: unknown; status?: RuntimeStatus; error?: string };
      if (!response.ok || payload.success !== true) throw new Error(payload.error || 'The queue change could not be confirmed. Refresh before trying again.');
      const queue = readQueue(payload.queue, sessionId);
      if (!isCurrent(frame) || controller.signal.aborted || frame.mutation !== controller) return;
      frame.queue = queue;
      setState({ token, queue, loading: false, readError: null, actionError: null, pendingId: null });
      if (payload.status?.sessionId === sessionId) applyStatus.current(payload.status);
    } catch (error) {
      if (isCurrent(frame) && !controller.signal.aborted && frame.mutation === controller)
        setState({ token, queue: frame.queue, loading: false, readError: null, actionError: error instanceof Error ? error.message : String(error), pendingId: null });
      throw error;
    } finally {
      if (frame.mutation === controller) frame.mutation = null;
      if (isCurrent(frame)) { frame.polls = 0; void read(frame); }
    }
  }, [isCurrent, read, sessionId, token, workspaceId]);
  const runExistingAction = useCallback(async (item: RuntimeQueueItem, action: () => Promise<void>) => {
    const frame = active.current;
    if (!frame || !isCurrent(frame) || !sessionId || !workspaceId || frame.mutation || frame.read || frame.readFailed
      || !frame.queue?.items.includes(item) || !item.queue || !['prompt', 'follow_up'].includes(item.queue.lane)
      || frame.queue.blocked.some(blocker => blocker.reason !== 'unknown_queue_position')) {
      const error = new Error('The selected queue entry changed. Refresh this chat.');
      if (frame && isCurrent(frame)) setState(previous => previous?.token === token ? { ...previous, actionError: error.message } : previous);
      throw error;
    }
    frame.sequence++; if (frame.poll) { clearTimeout(frame.poll); frame.poll = null; }
    const controller = new AbortController(); frame.mutation = controller;
    setState({ token, queue: frame.queue, loading: false, readError: null, actionError: null, pendingId: item.id });
    try {
      await action();
    } catch (error) {
      if (isCurrent(frame) && !controller.signal.aborted && frame.mutation === controller)
        setState({ token, queue: frame.queue, loading: false, readError: null,
          actionError: error instanceof Error ? error.message : String(error), pendingId: null });
      throw error;
    } finally {
      if (frame.mutation === controller) frame.mutation = null;
      if (isCurrent(frame)) { frame.polls = 0; void read(frame); }
    }
  }, [isCurrent, read, sessionId, token, workspaceId]);
  const current = state?.token === token ? state : null;
  const loading = Boolean(sessionId && (!current || current.loading));
  const error = current?.actionError || current?.readError || null;
  const runtimeBusy = runtimeStatus?.sessionId === sessionId && (runtimeStatus.phase !== 'idle' || runtimeStatus.compactionStatus?.state === 'running');
  const awaitingReady = !runtimeBusy && Boolean(current?.queue?.items.some(item => item.queue?.disposition === 'ready'));
  return { queue: current?.queue ?? null, loading, error, pendingId: current?.pendingId ?? null, refresh, control, runExistingAction, runtimeBusy, awaitingReady,
    actionsDisabled: Boolean(loading || !current?.queue || current.readError),
    sendBlocked: Boolean(sessionId && (loading || !current?.queue || error || current.pendingId || current.queue.blocked.length || awaitingReady)) };
}
