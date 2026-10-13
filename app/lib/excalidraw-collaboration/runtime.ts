import 'server-only';

import type { PoolClient } from 'pg';
import { getPostgresRuntimeQueryable } from '@/app/lib/db';
import { loadExcalidrawScene, type AppliedExcalidrawPatch, type PersistedExcalidrawScene } from './repository';

export const EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL = 'canvas_excalidraw_scene';

type RuntimeBridge = {
  connectionCount: (documentId: string) => number;
  publishApplied: (
    documentId: string,
    operationId: string,
    result: AppliedExcalidrawPatch,
    attribution: { actorId: string; initiatedByUserId: string },
  ) => void;
};

let bridge: RuntimeBridge | null = null;

export function installExcalidrawCollaborationRuntime(next: RuntimeBridge): () => void {
  bridge = next;
  return () => { if (bridge === next) bridge = null; };
}

export function getExcalidrawConnectionCount(documentId: string): number {
  return bridge?.connectionCount(documentId) ?? 0;
}

export function publishExcalidrawAgentPatch(
  documentId: string,
  operationId: string,
  result: AppliedExcalidrawPatch,
  attribution: { actorId: string; initiatedByUserId: string },
): void {
  bridge?.publishApplied(documentId, operationId, result, attribution);
}

/** PostgreSQL notifications are hints; only a freshly loaded durable scene is broadcast. */
export function installExcalidrawSceneNotificationListener(options: {
  documentIds: () => Iterable<string>;
  onScene: (state: PersistedExcalidrawScene, operationId?: string) => void | Promise<void>;
  onReconnect?: () => void | Promise<void>;
  onError?: (error: unknown) => void;
  connect?: () => Promise<PoolClient>;
  loadScene?: typeof loadExcalidrawScene;
  retryMs?: number;
}): { ready: Promise<void>; resync: () => Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let client: PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const delivered = new Map<string, { generation: number; sequence: number; path: string; status: string }>();
  const inFlight = new Map<string, Promise<void>>();
  const load = options.loadScene ?? loadExcalidrawScene;
  const report = (error: unknown) => options.onError?.(error);
  const refresh = (documentId: string, operationId?: string, force = false): Promise<void> => {
    const previous = inFlight.get(documentId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (stopped || !new Set(options.documentIds()).has(documentId)) return;
      const state = await load(documentId, true);
      if (!state || stopped) return;
      const seen = delivered.get(documentId);
      if (!force && seen?.generation === state.lifecycleGeneration && seen.sequence >= state.sceneSequence
        && seen.path === state.path && seen.status === state.status) return;
      await options.onScene(state, operationId);
      delivered.set(documentId, { generation: state.lifecycleGeneration, sequence: state.sceneSequence,
        path: state.path, status: state.status });
      if (delivered.size > 10_000) delivered.delete(delivered.keys().next().value!);
    }).finally(() => { if (inFlight.get(documentId) === work) inFlight.delete(documentId); });
    inFlight.set(documentId, work);
    return work;
  };
  const resync = async () => {
    for (const documentId of options.documentIds()) await refresh(documentId, undefined, true);
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
      const next = await (options.connect ? options.connect() : (() => {
        const pool = getPostgresRuntimeQueryable();
        if (!pool) throw new Error('Excalidraw notifications require a PostgreSQL runtime.');
        return pool.connect();
      })());
      if (stopped) { next.release(true); return; }
      client = next;
      const disconnected = (error?: Error) => {
        if (client !== next) return;
        client = null;
        next.release(true);
        if (error) report(error);
        scheduleReconnect();
      };
      next.on('error', disconnected);
      next.on('end', disconnected);
      next.on('notification', (notification) => {
        if (client !== next || notification.channel !== EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL
          || !notification.payload || notification.payload.length > 4_096) return;
        try {
          const payload = JSON.parse(notification.payload) as { documentId?: unknown; sceneSequence?: unknown; operationId?: unknown };
          if (typeof payload.documentId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(payload.documentId)
            || !Number.isSafeInteger(payload.sceneSequence) || Number(payload.sceneSequence) < 0) return;
          const operationId = typeof payload.operationId === 'string' && payload.operationId.length <= 256 ? payload.operationId : undefined;
          void refresh(payload.documentId, operationId).catch(report);
        } catch { /* Ignore malformed hints; periodic resync still reads durable state. */ }
      });
      try {
        await next.query(`LISTEN ${EXCALIDRAW_SCENE_NOTIFICATION_CHANNEL}`);
        await resync();
        await options.onReconnect?.();
      } catch (error) {
        disconnected(error instanceof Error ? error : new Error('Excalidraw notification connection failed.'));
        throw error;
      }
    })().catch(error => { scheduleReconnect(); throw error; }).finally(() => { connecting = null; });
    return connecting;
  };
  const ready = connect();
  void ready.catch(report);
  return { ready, resync, stop: async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    const current = client;
    client = null;
    current?.release(true);
    await connecting?.catch(() => undefined);
    await Promise.allSettled(inFlight.values());
    delivered.clear();
  } };
}
