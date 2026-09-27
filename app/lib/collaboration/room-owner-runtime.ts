import 'server-only';

import type { Doc } from 'yjs';
import { createCollaborationRoomActivityGate } from './room-activity-gate';
import {
  CollaborationRoomOwnerError,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
  type createCollaborationRoomOwnerSession,
} from './room-owner';

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
export type CollaborationRoomOwnerRuntimeOptions = {
  createSession: (onInvalidated: () => void) => Promise<OwnerSession>;
  heartbeatMs?: number;
};

type OwnedRoom = {
  document: Doc;
  scope: CollaborationRoomOwnerScope;
  claim: Promise<CollaborationRoomOwnerFence>;
  proof?: CollaborationRoomOwnerFence;
  releasing?: Promise<void>;
  destroy: () => void;
};

/**
 * Binds ownership to concrete Y.Doc instances, not just reusable document IDs.
 * Session loss is terminal: preserve/quarantine live documents, never replay
 * their uncommitted state under a replacement owner automatically.
 */
export function createCollaborationRoomOwnerRuntime(options: CollaborationRoomOwnerRuntimeOptions & {
  onLost: (document: Doc) => void;
}) {
  const heartbeatMs = options.heartbeatMs ?? 1_000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 60_000) {
    throw new Error('Invalid collaboration owner heartbeat interval.');
  }
  const rooms = new Map<string, OwnedRoom>();
  const instances = new WeakMap<Doc, OwnedRoom>();
  const activities = createCollaborationRoomActivityGate();
  const activityDrains = new Set<string>();
  let lost = false;
  let disposed = false;
  let session: OwnerSession | undefined;
  let opening: Promise<OwnerSession> | undefined;
  let closing: Promise<void> | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let probing = false;
  const invalidate = () => {
    if (lost) return;
    lost = true;
    activities.dispose();
    if (heartbeat) clearInterval(heartbeat);
    for (const room of rooms.values()) {
      if (room.document.isDestroyed) continue;
      try { options.onLost(room.document); }
      catch { console.error('[Collaboration] Owned room invalidation handler failed.'); }
    }
  };
  const assertAvailable = () => {
    if (lost || disposed) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
  };
  const admitActivity = (documentId: string) => {
    assertAvailable();
    try { return activities.admit(documentId); }
    catch { throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY'); }
  };
  const beginActivityDrain = (documentId: string) => {
    assertAvailable();
    const drain = activities.beginDrain(documentId);
    activityDrains.add(documentId);
    let finished = false;
    return {
      idle: drain.idle,
      finish() {
        if (finished) return;
        drain.finish();
        finished = true;
        activityDrains.delete(documentId);
      },
    };
  };
  const closeSession = () => {
    invalidate();
    // A late factory result must also be closed. Its continuation below does
    // that without keeping dispose blocked on an unavailable connection.
    closing ??= session ? session.close() : Promise.resolve();
    return closing;
  };
  const getSession = (): Promise<OwnerSession> => {
    assertAvailable();
    opening ??= (async () => {
      let timer: NodeJS.Timeout | undefined;
      const created = Promise.resolve().then(() => options.createSession(invalidate));
      void created.then((value) => {
        if (lost || disposed) void value.close().catch(() => undefined);
      }, () => undefined);
      try {
        const value = await Promise.race([created, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE')), 5_000);
        })]);
        assertAvailable();
        session = value;
        heartbeat = setInterval(() => {
          if (probing || lost || disposed) return;
          probing = true;
          void value.probe().catch(() => closeSession()).catch(() => undefined)
            .finally(() => { probing = false; });
        }, heartbeatMs);
        heartbeat.unref();
        return value;
      } catch {
        invalidate();
        throw new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE');
      } finally { if (timer) clearTimeout(timer); }
    })();
    return opening;
  };
  const forget = (room: OwnedRoom) => {
    room.document.off('destroy', room.destroy);
    if (rooms.get(room.scope.documentId) === room) rooms.delete(room.scope.documentId);
    // Keep the weak instance record: a released Doc must never acquire again.
  };
  const release = (document: Doc): Promise<void> => {
    const room = instances.get(document);
    if (!room) return Promise.resolve();
    if (room.releasing) return room.releasing;
    // Set the promise before its first continuation. fence() now rejects even
    // while acquire or the database release acknowledgement is pending.
    room.releasing = Promise.resolve().then(async () => {
      let proof: CollaborationRoomOwnerFence;
      try { proof = await room.claim; }
      catch { forget(room); return; }
      try {
        assertAvailable();
        await session!.release(proof);
        forget(room);
      } catch (error) {
        // Even queue saturation cannot strand a held lock indefinitely.
        // Close the session and quarantine its other rooms; do not pretend
        // that a failed release made this ID available again.
        await closeSession().catch(() => undefined);
        throw error;
      }
    });
    // destroy listeners cannot await; callers/afterUnload still receive the
    // original rejection, while no unhandled rejection escapes the emitter.
    void room.releasing.catch(() => undefined);
    return room.releasing;
  };
  const claim = async (document: Doc, input: CollaborationRoomOwnerScope): Promise<CollaborationRoomOwnerFence> => {
    assertAvailable();
    if (document.isDestroyed || instances.has(document)) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    // Callers may pass a persisted state object. Retain only the scalar scope,
    // never its potentially large binary snapshots or unrelated metadata.
    const scope = Object.freeze({ documentId: input.documentId, workspaceId: input.workspaceId,
      organizationId: input.organizationId, path: input.path, representation: input.representation,
      lifecycleGeneration: input.lifecycleGeneration, schemaVersion: input.schemaVersion });
    const old = rooms.get(scope.documentId);
    if (old?.releasing) await old.releasing;
    assertAvailable();
    if (document.isDestroyed || instances.has(document)) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    if (rooms.has(scope.documentId) || rooms.size >= 256) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
    const room: OwnedRoom = {
      document, scope,
      claim: Promise.resolve().then(async () => {
        const value = await getSession();
        assertAvailable();
        if (document.isDestroyed) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
        const proof = await value.acquire(scope);
        room.proof = proof;
        return proof;
      }),
      destroy: () => { void release(document); },
    };
    instances.set(document, room);
    rooms.set(scope.documentId, room);
    document.on('destroy', room.destroy);
    try {
      const proof = await room.claim;
      assertAvailable();
      if (document.isDestroyed || room.releasing) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      session!.assertActive(proof);
      return proof;
    } catch (error) {
      if (room.proof) await release(document).catch(() => undefined);
      else forget(room);
      throw error;
    }
  };
  const fence = (document: Doc) => {
    assertAvailable();
    const room = instances.get(document);
    if (!room?.proof || room.releasing || document.isDestroyed || rooms.get(room.scope.documentId) !== room) {
      throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
    }
    session!.assertActive(room.proof);
    return room.proof;
  };
  return {
    claim, fence, release, assertAvailable, admitActivity,
    // Quiescence only: the caller must still persist, prove release and retain
    // its lifecycle reservation before reopening admission with finish().
    beginActivityDrain,
    // Failed/lost stores must not be followed by Hocuspocus's unconditional
    // direct-disconnect unload. Retain unacknowledged data for recovery.
    canUnload: (document: Doc) => {
      const room = instances.get(document);
      return !room || (!lost && !disposed && !activityDrains.has(room.scope.documentId));
    },
    waitForRelease: async (documentName: string) => { await rooms.get(documentName)?.releasing; },
    dispose: () => { disposed = true; return closeSession(); },
  };
}
