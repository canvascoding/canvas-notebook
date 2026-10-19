import 'server-only';

import type { Notification, PoolClient } from 'pg';
import { getPostgresRuntimeQueryable, type SqlConnection } from '@/app/lib/db';
import { isWorkspaceFileInvalidation, type WorkspaceFileInvalidation } from '@/app/lib/files/file-events';

export const WORKSPACE_FILE_INVALIDATION_CHANNEL = 'canvas_workspace_files';

/** The fixed terminal Owner calls this on its actual B. PostgreSQL delivers
 * the hint only after that transaction commits; rollback publishes nothing. */
export async function notifyWorkspaceFileInvalidationOnConnection(database: SqlConnection, workspaceId: string): Promise<void> {
  const hint = { workspaceId };
  if (!isWorkspaceFileInvalidation(hint)) throw new Error('WORKSPACE_FILE_INVALIDATION_INVALID');
  await database.run('SELECT pg_catalog.pg_notify($1, $2)', [WORKSPACE_FILE_INVALIDATION_CHANNEL, JSON.stringify(hint)]);
}

/** Notifications carry no document state or authorization. Every consumer must
 * resolve its own document ID through the existing current-authority API. */
export function installWorkspaceFileInvalidationNotificationListener(options: {
  workspaceIds: () => Iterable<string>;
  onInvalidate: (hint: WorkspaceFileInvalidation) => void | Promise<void>;
  onError?: (error: unknown) => void;
  connect?: () => Promise<PoolClient>;
  retryMs?: number;
}): { ready: Promise<void>; resync: () => Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let client: PoolClient | null = null;
  let handlers: { disconnected: (error?: Error) => void; onNotification: (notification: Notification) => void } | null = null;
  let connecting: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const inFlight = new Set<Promise<void>>();
  const report = (error: unknown) => {
    try { options.onError?.(error); } catch { /* Reporting cannot create an unhandled background rejection. */ }
  };
  const resync = (workspaceId?: string): Promise<void> => {
    if (stopped) return Promise.resolve();
    const work = (async () => {
      const selected = workspaceId === undefined ? new Set(options.workspaceIds()) : new Set([workspaceId]);
      for (const selectedId of selected) {
        if (stopped) return;
        const hint = Object.freeze({ workspaceId: selectedId });
        if (!isWorkspaceFileInvalidation(hint) || !new Set(options.workspaceIds()).has(selectedId)) continue;
        await options.onInvalidate(hint);
      }
    })().finally(() => { inFlight.delete(work); });
    inFlight.add(work);
    return work;
  };
  const scheduleReconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = null; void connect().catch(report); }, options.retryMs ?? 1_000);
    retry.unref?.();
  };
  const connect = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      let adopted = false;
      let acquisitionError: Error | undefined;
      const disconnected = (error?: Error) => {
        if (!adopted) {
          acquisitionError ??= error ?? new Error('Workspace invalidation notification connection ended during acquisition.');
          return;
        }
        if (client !== next) return;
        client = null;
        handlers = null;
        next.removeListener('error', disconnected);
        next.removeListener('end', disconnected);
        next.removeListener('notification', onNotification);
        try { next.release(true); } catch (cause) { report(cause); }
        if (error) report(error);
        scheduleReconnect();
      };
      const next = await (options.connect ? options.connect() : new Promise<PoolClient>((resolve, reject) => {
        const pool = getPostgresRuntimeQueryable();
        if (!pool) { reject(new Error('Workspace invalidation notifications require a PostgreSQL runtime.')); return; }
        // pg removes its idle error handler before handing out a client. Own
        // errors synchronously in that callback, before any await continuation.
        pool.connect((error, acquired) => {
          if (error || !acquired) { reject(error ?? new Error('Workspace invalidation notification client acquisition failed.')); return; }
          acquired.on('error', disconnected);
          acquired.on('end', disconnected);
          resolve(acquired);
        });
      }));
      if (options.connect) {
        next.on('error', disconnected);
        next.on('end', disconnected);
      }
      if (stopped || acquisitionError) {
        next.removeListener('error', disconnected);
        next.removeListener('end', disconnected);
        try { next.release(true); } catch (error) { report(error); }
        if (acquisitionError) throw acquisitionError;
        return;
      }
      const onNotification = (notification: Notification) => {
        if (stopped || client !== next || notification.channel !== WORKSPACE_FILE_INVALIDATION_CHANNEL
          || typeof notification.payload !== 'string' || notification.payload.length > 4_096) return;
        try {
          const hint: unknown = JSON.parse(notification.payload);
          if (!isWorkspaceFileInvalidation(hint)) return;
          void resync(hint.workspaceId).catch(report);
        } catch { /* Malformed hints are ignored; reconnect resync still refreshes subscribed identities. */ }
      };
      handlers = { disconnected, onNotification };
      client = next;
      adopted = true;
      next.on('notification', onNotification);
      try {
        await next.query(`LISTEN ${WORKSPACE_FILE_INVALIDATION_CHANNEL}`);
        if (!stopped && client === next) await resync();
      } catch (error) {
        disconnected(error instanceof Error ? error : new Error('Workspace invalidation notification connection failed.'));
        throw error;
      }
    })().catch(error => { scheduleReconnect(); throw error; }).finally(() => {
      connecting = null;
      // A retry may have observed this same still-pending connect while an
      // initial async resync was draining. Never lose that reconnect request.
      if (!stopped && !client) scheduleReconnect();
    });
    return connecting;
  };
  const ready = connect();
  void ready.catch(report);
  return { ready, resync, stop: () => {
    if (stopping) return stopping;
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    const current = client;
    const currentHandlers = handlers;
    client = null;
    handlers = null;
    if (current && currentHandlers) {
      current.removeListener('error', currentHandlers.disconnected);
      current.removeListener('end', currentHandlers.disconnected);
      current.removeListener('notification', currentHandlers.onNotification);
    }
    stopping = (async () => {
      try { current?.release(true); } catch (error) { report(error); }
      await connecting?.catch(report);
      await Promise.allSettled(inFlight);
      inFlight.clear();
    })();
    return stopping;
  } };
}
