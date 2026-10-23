import 'server-only';

import type { NextRequest } from 'next/server';
import { openDb, type SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { CollaborationTicketClaims } from './types';
import type { ExistingNativeSessionIdentity } from './native-session-state-reader';
import { assertAuthenticatedNativePeerClaims } from './authenticated-native-peer';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { NATIVE_PEER_ADMISSION_BUSY_REASON } from './failure';
import { createAuthenticatedNativePeerOrigin, adoptAuthenticatedNativePeerOrigin,
  captureAuthenticatedNativePeerOriginTransportOnConnection, withAuthenticatedNativePeerOriginJoinOnConnection,
  retireAuthenticatedNativePeerOriginAttempt, finishAuthenticatedNativePeerOrigin, disposeAuthenticatedNativePeerOrigin,
  type AuthenticatedNativeSessionTransport } from './authenticated-native-session-transport';

type Closure = { rollback: boolean; commitAttempted: boolean; closed: boolean; operationError?: unknown };

/** Observes real forwarded acknowledgements only. The lifecycle core still owns
 * BEGIN/ROLLBACK/COMMIT/discard/close, and every SQL result is returned intact. */
function observedConnection(database: SqlConnection, closure: Closure): SqlConnection {
  return {
    get: (sql, values) => database.get(sql, values),
    all: (sql, values) => database.all(sql, values),
    run: async (sql, values) => {
      if (sql === 'COMMIT') closure.commitAttempted = true;
      const result = await database.run(sql, values);
      if (sql === 'ROLLBACK') closure.rollback = true;
      return result;
    },
    close: async error => { await database.close(error); closure.closed = true; },
  };
}

/** One original-auth Socket admission. HTTP's already completed read budget is
 * separate. A mobile cap is the first Capture; its ticket is never consumed here.
 * No caller validator, permissions facade, original-header getter or DB injection. */
export async function authenticateNativePeerAdmission(input: {
  request: NextRequest; claims: CollaborationTicketClaims; transport?: AuthenticatedNativeSessionTransport; signal?: AbortSignal;
}): Promise<{ transport: AuthenticatedNativeSessionTransport; identity: ExistingNativeSessionIdentity; workspace: WorkspaceContext }> {
  const claims = Object.freeze({ ...input.claims }), signal = input.signal;
  // Synchronous original-header capture/adoption before the first authentication await.
  const origin = input.transport ? adoptAuthenticatedNativePeerOrigin(input.transport)
    : createAuthenticatedNativePeerOrigin(input.request, { workspaceId: claims.workspaceId,
      maxPermission: claims.permission === 'write' ? 'canWrite' : 'canRead' });
  let transport = input.transport;
  const current = () => {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= Date.now()) throw new Error('Native collaboration ticket expired during admission.');
  };
  const abort = () => { void disposeAuthenticatedNativePeerOrigin(origin).catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      current();
      let closure: Closure = { rollback: false, commitAttempted: false, closed: false };
      const phase = async <T>(operation: (database: SqlConnection) => Promise<T>): Promise<T> => {
        closure = { rollback: false, commitAttempted: false, closed: false };
        const observed = closure;
        return executeLifecycleTransaction({
          openConnection: async () => observedConnection(await openDb(), observed),
          execute: async database => {
            current();
            try { const value = await operation(database); current(); return value; }
            catch (error) { observed.operationError = error; throw error; }
          },
          // An attempted COMMIT is never replayed, whether rejected or acknowledged later.
          recoverCommitted: async () => { throw new Error('Native admission commit could not be confirmed.'); },
        });
      };
      try {
        if (!transport) transport = await phase(database => captureAuthenticatedNativePeerOriginTransportOnConnection(database, origin));
        current();
        const enrolled = transport;
        const joined = await phase(database => withAuthenticatedNativePeerOriginJoinOnConnection(database, origin, enrolled,
          { path: claims.path, permission: claims.permission }, async (session, access) => {
            current();
            const snapshot = session.snapshot;
            const identity = Object.freeze({ documentId: snapshot.documentId, lineageId: snapshot.lineageId,
              workspaceId: snapshot.workspaceId, organizationId: snapshot.organizationId, path: snapshot.path,
              lifecycleGeneration: snapshot.lifecycleGeneration, representation: snapshot.representation, schemaVersion: snapshot.schemaVersion });
            assertAuthenticatedNativePeerClaims(claims, identity, access);
            return { identity, workspace: access.workspace };
          }));
        current();
        // The actual Join core has confirmed COMMIT and successful close here.
        finishAuthenticatedNativePeerOrigin(origin, enrolled);
        return { transport: enrolled, ...joined };
      } catch (error) {
        // Error identity plus private broker provenance and all genuine cleanup
        // acknowledgements are necessary. Code strings alone never retry.
        if (closure.commitAttempted || !closure.rollback || !closure.closed || closure.operationError !== error) throw error;
        const eligible = await retireAuthenticatedNativePeerOriginAttempt(origin, error);
        if (!eligible) throw error;
        transport = undefined;
        current();
        if (attempt === 2) {
          throw Object.assign(new Error('Native collaboration admission is busy.'), { reason: NATIVE_PEER_ADMISSION_BUSY_REASON });
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        current();
      }
    }
    throw new Error('Native admission attempt budget exhausted.');
  } finally {
    signal?.removeEventListener('abort', abort);
    await disposeAuthenticatedNativePeerOrigin(origin);
  }
}
