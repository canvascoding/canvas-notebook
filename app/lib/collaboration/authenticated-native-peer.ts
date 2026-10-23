import 'server-only';

import { openDb } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { CollaborationTicketClaims } from './types';
import type { ExistingNativeSessionIdentity } from './native-session-state-reader';
import type { CollaborationRoomOwnerFence } from './room-owner';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { AuthenticatedNativeSessionTransportError, disposeAuthenticatedNativeSessionTransport,
  isAuthenticatedNativeSessionTransportBusy, withAuthenticatedOwnedNativeSessionTransportOnConnection,
  type AuthenticatedNativeSessionTransport, type AuthenticatedOwnedNativeSessionAccess } from './authenticated-native-session-transport';

/** Ticket selectors are matched only against actual original-auth B access. */
export function assertAuthenticatedNativePeerClaims(claims: CollaborationTicketClaims,
  identity: ExistingNativeSessionIdentity, access: Pick<AuthenticatedOwnedNativeSessionAccess, 'userId' | 'sessionId' | 'workspace'>): void {
  if (claims.provider !== 'yjs' || claims.guestInvitationId || claims.userId !== access.userId || claims.sessionId !== access.sessionId
    || identity.workspaceId !== access.workspace.workspaceId || identity.organizationId !== (access.workspace.organizationId ?? null)
    || (['documentId','workspaceId','organizationId','path','lifecycleGeneration','representation','schemaVersion'] as const)
      .some(key => claims[key] !== identity[key])) throw new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_SCOPE_CHANGED');
}

/** The socket owns only an opaque original-header transport. Every read/write
 * phase has a fresh, bounded actual B; private serialization prevents a monitor
 * from reentering a message's phase. No principal facade survives its callback. */
export function createAuthenticatedNativePeer(input: {
  transport: AuthenticatedNativeSessionTransport; claims: CollaborationTicketClaims; identity: ExistingNativeSessionIdentity;
}) {
  const transport = input.transport, claims = Object.freeze({ ...input.claims }), identity = Object.freeze({ ...input.identity });
  let tail: Promise<unknown> = Promise.resolve(), closed = false, failure: unknown, disposing: Promise<void> | undefined;
  const assertOpen = () => {
    if (failure !== undefined) throw failure;
    if (closed) throw new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_DISPOSED');
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = tail.then(() => { assertOpen(); return operation(); }).catch(error => {
      // A failed fresh check never resolves as cached authority. Only the
      // transport's internally proven pre-callback contention is retryable.
      if (!isAuthenticatedNativeSessionTransportBusy(error)) failure ??= error;
      throw error;
    });
    tail = pending.catch(() => undefined);
    return pending;
  };
  const phase = <T>(permission: 'canRead' | 'canWrite', ownerFence: CollaborationRoomOwnerFence,
    consume: (access: AuthenticatedOwnedNativeSessionAccess) => Promise<T>) => executeLifecycleTransaction({
    openConnection: openDb,
    execute: database => withAuthenticatedOwnedNativeSessionTransportOnConnection(database, transport,
      { permission, identity, ownerFence }, async access => {
        assertOpen(); assertAuthenticatedNativePeerClaims(claims, identity, access);
        return consume(access);
      }),
    // A lost COMMIT reply destroys B. It proves no fresh permission or accepted
    // publication and cannot replay an already applied Yjs update on a new B.
    recoverCommitted: async () => { throw new Error('Native peer authorization commit could not be confirmed.'); },
  });
  return {
    check(ownerFence: CollaborationRoomOwnerFence): Promise<{ workspace: WorkspaceContext; quarantined: boolean }> {
      return enqueue(async () => {
        const read = await phase('canRead', ownerFence, async access => ({ workspace: access.workspace, quarantined: access.quarantined }));
        if (!read.quarantined && claims.permission === 'write') {
          return phase('canWrite', ownerFence, async access => ({ workspace: access.workspace, quarantined: access.quarantined }));
        }
        return read;
      });
    },
    /** Called after the concrete room mutation queue, before any live apply.
     * Every final authorization and COMMIT/close must succeed first: Y.Doc and
     * its broadcast cannot be rolled back by a later SQL failure. This result
     * is consumed by this one message hook, never retained as socket authority. */
    authorizeWrite(ownerFence: CollaborationRoomOwnerFence): Promise<void> {
      if (claims.permission !== 'write') return Promise.reject(new AuthenticatedNativeSessionTransportError('NATIVE_TRANSPORT_ACCESS_DENIED'));
      return enqueue(async () => {
        await phase('canWrite', ownerFence, async () => undefined);
        assertOpen();
      });
    },
    dispose(): Promise<void> {
      if (disposing) return disposing;
      closed = true;
      disposing = (async () => {
        await tail;
        await disposeAuthenticatedNativeSessionTransport(transport);
      })();
      return disposing;
    },
  };
}
