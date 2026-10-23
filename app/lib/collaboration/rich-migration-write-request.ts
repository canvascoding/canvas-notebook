import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../db';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceRequestPrincipal, WorkspaceRequestPrincipalAccess } from '../workspaces/request-principal';
import { isCanonicalAdmissionPath } from './room-admission-contract';
import { parseRichMigrationRequest, type RichMigrationRequest } from './representation-migration-contract';

/** Expectations only. These fields establish no native identity or mutation claim. */
export type RichMigrationWriteRequestInput = Readonly<{
  workspaceId: string; path: string; migration: RichMigrationRequest; action: 'advance' | 'cancel';
}>;
declare const attemptBrand: unique symbol;
/** Minted exclusively by the genuine Request factory with FIXED canWrite. */
export type RichMigrationWriteAttempt = Readonly<{ [attemptBrand]: never }>;
export type RichMigrationWriteRequestAccess = Readonly<{
  input: RichMigrationWriteRequestInput; workspace: WorkspaceContext; userId: string; sessionId: string;
  assertCurrent: () => Promise<void>;
}>;
type Attempt = {
  input: RichMigrationWriteRequestInput; principal: WorkspaceRequestPrincipal;
  active: boolean; accepting: boolean; failure: unknown; pending: Set<Promise<unknown>>;
};
type Phase = {
  attempt: Attempt; database: SqlConnection; active: boolean; callbackActive: boolean;
  failure: unknown; deadline: number;
};
const attempts = new WeakMap<RichMigrationWriteAttempt, Attempt>();
const phases = new WeakMap<SqlConnection, Phase>();
const requestContext = new AsyncLocalStorage<Attempt>();
const callbackContext = new AsyncLocalStorage<Phase>();
const MAX_CALLBACK_MS = 5000;
const inputKeys = ['workspaceId', 'path', 'migration', 'action'];
const migrationKeys = ['requestId', 'expectedDocumentId', 'expectedLifecycleGeneration', 'documentSequence', 'stateProof'];
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256
  && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);

export class RichMigrationWriteRequestError extends Error {
  constructor(readonly code: 'RICH_MIGRATION_WRITE_INVALID' | 'RICH_MIGRATION_WRITE_REQUIRED'
    | 'RICH_MIGRATION_WRITE_REENTRANT' | 'RICH_MIGRATION_WRITE_DETACHED' | 'RICH_MIGRATION_WRITE_EXPIRED') {
    super(code); this.name = 'RichMigrationWriteRequestError';
  }
}
function fail(code: RichMigrationWriteRequestError['code']): never { throw new RichMigrationWriteRequestError(code); }
function failure(error: unknown): unknown { return error ?? new RichMigrationWriteRequestError('RICH_MIGRATION_WRITE_INVALID'); }
function poison(database: SqlConnection | undefined, attempt: Attempt | undefined, error: unknown): unknown {
  const reason = failure(error), held = database && phases.get(database);
  for (const owner of [attempt, requestContext.getStore(), held?.attempt]) if (owner?.active) owner.failure ??= reason;
  if (held?.active) held.failure ??= reason;
  return (attempt?.active ? attempt.failure : undefined) ?? held?.failure ?? reason;
}
function dataObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      return descriptor?.enumerable && Object.prototype.hasOwnProperty.call(descriptor,'value');
    });
}
function captureInput(input: RichMigrationWriteRequestInput): RichMigrationWriteRequestInput {
  if (!dataObject(input,inputKeys) || !validId(input.workspaceId) || !isCanonicalAdmissionPath(input.path)
    || !['advance','cancel'].includes(input.action) || !dataObject(input.migration,migrationKeys)) fail('RICH_MIGRATION_WRITE_INVALID');
  const migration = parseRichMigrationRequest(input.migration);
  if (!migration) fail('RICH_MIGRATION_WRITE_INVALID');
  return Object.freeze({ workspaceId:input.workspaceId, path:input.path, migration, action:input.action });
}
function assertAttempt(attempt: Attempt): void {
  if (!attempt.active || !attempt.accepting || requestContext.getStore() !== attempt) fail('RICH_MIGRATION_WRITE_REQUIRED');
  if (attempt.failure !== undefined) throw attempt.failure;
}
function assertPhase(phase: Phase, callback = false): void {
  assertAttempt(phase.attempt);
  if (!phase.active || phases.get(phase.database) !== phase || callback && (!phase.callbackActive || callbackContext.getStore() !== phase)) {
    fail('RICH_MIGRATION_WRITE_REQUIRED');
  }
  if (phase.failure !== undefined) throw phase.failure;
  if (performance.now() > phase.deadline) fail('RICH_MIGRATION_WRITE_EXPIRED');
}
function bindAccess(phase: Phase, actual: WorkspaceRequestPrincipalAccess): RichMigrationWriteRequestAccess {
  const check = () => {
    try { assertPhase(phase,true); }
    catch (error) { throw poison(phase.database,phase.attempt,error); }
  };
  const assertCurrent = (): Promise<void> => {
    try { check(); }
    catch (error) { return Promise.reject(error); }
    return actual.assertCurrent().then(() => { check(); }).catch(error => { throw poison(phase.database,phase.attempt,error); });
  };
  return Object.freeze(Object.defineProperties({}, {
    input: { enumerable:true, get:() => { check(); return phase.attempt.input; } },
    workspace: { enumerable:true, get:() => { check(); return actual.workspace; } },
    userId: { enumerable:true, get:() => { check(); return actual.userId; } },
    sessionId: { enumerable:true, get:() => { check(); return actual.sessionId; } },
    assertCurrent: { enumerable:true, get:() => { check(); return assertCurrent; } },
  })) as RichMigrationWriteRequestAccess;
}

/** Inactive Auth foundation only. Does not open/close SQL or grant content,
 * document/room/lifecycle/admission, projection, ticket or COMMIT authority. */
export async function withRichMigrationWriteRequest<T>(request: NextRequest, input: RichMigrationWriteRequestInput,
  operation: (attempt: RichMigrationWriteAttempt) => Promise<T>): Promise<T> {
  let original: NextRequest, capturedInput: RichMigrationWriteRequestInput;
  try {
    if (!(request instanceof NextRequest) || typeof operation !== 'function') fail('RICH_MIGRATION_WRITE_INVALID');
    capturedInput = captureInput(input);
    // Copy genuine Request headers/selectors and command expectations before ANY await.
    original = new NextRequest(request.url,{ method:request.method, headers:new Headers(request.headers) });
  } catch (error) { throw poison(undefined,undefined,error); }
  const { withWorkspaceRequestPrincipal } = await import('../workspaces/request-principal');
  return withWorkspaceRequestPrincipal(original,{ permission:'canWrite', workspaceId:capturedInput.workspaceId },async principal => {
    const owner: Attempt = { input:capturedInput, principal, active:true, accepting:true, failure:undefined, pending:new Set() };
    const capability = Object.freeze({}) as RichMigrationWriteAttempt; attempts.set(capability,owner);
    return requestContext.run(owner,async () => {
      try {
        let result: T | undefined;
        try { result = await operation(capability); } catch (error) { owner.failure ??= failure(error); }
        owner.accepting = false;
        if (owner.pending.size) {
          owner.failure ??= new RichMigrationWriteRequestError('RICH_MIGRATION_WRITE_DETACHED');
          await Promise.allSettled([...owner.pending]);
        }
        if (owner.failure !== undefined) throw owner.failure;
        return result as T;
      } finally { owner.active = false; owner.accepting = false; }
    });
  }).catch(error => { throw poison(undefined,undefined,error); });
}

/** Caller owns a real RC/RW B, mandatory rollback on ANY failure, all native
 * fences and commit/recovery. Serial fresh phases are allowed inside the same
 * genuine Request callback; no wrapped/foreign Principal or permissions input. */
export function withRichMigrationWriteRequestOnConnection<T>(database: SqlConnection, capability: RichMigrationWriteAttempt,
  operation: (access: RichMigrationWriteRequestAccess) => Promise<T>): Promise<T> {
  const attempt = attempts.get(capability);
  try {
    if (!attempt) fail('RICH_MIGRATION_WRITE_REQUIRED');
    assertAttempt(attempt);
    if (!database || typeof database !== 'object' || !['get','all','run'].every(key => typeof Reflect.get(database,key) === 'function')
      || typeof operation !== 'function') fail('RICH_MIGRATION_WRITE_INVALID');
    if (attempt.pending.size || phases.has(database)) fail('RICH_MIGRATION_WRITE_REENTRANT');
  } catch (error) { return Promise.reject(poison(database,attempt,error)); }
  const phase: Phase = { attempt, database, active:true, callbackActive:false, failure:undefined, deadline:performance.now()+MAX_CALLBACK_MS };
  phases.set(database,phase);
  const pending = (async () => {
    try {
      const { withWorkspaceRequestPrincipalOnConnection } = await import('../workspaces/request-principal');
      assertPhase(phase);
      const result = await withWorkspaceRequestPrincipalOnConnection(database,attempt.principal,async actual => {
        assertPhase(phase);
        if (actual.workspace.workspaceId !== attempt.input.workspaceId || !actual.workspace.permissions.canWrite) {
          fail('RICH_MIGRATION_WRITE_REQUIRED');
        }
        phase.callbackActive = true;
        try { return await callbackContext.run(phase,() => operation(bindAccess(phase,actual))); }
        catch (error) { throw poison(database,attempt,error); }
        finally { phase.callbackActive = false; }
      });
      // Retain the private binding through the WHOLE Principal promise, including
      // its outer final auth SQL. Caught misuse in that window must remain fatal.
      assertPhase(phase);
      return result;
    } catch (error) { throw poison(database,attempt,error); }
    finally { phase.active = false; phase.callbackActive = false; if (phases.get(database) === phase) phases.delete(database); }
  })();
  attempt.pending.add(pending);
  void pending.then(() => attempt.pending.delete(pending),() => attempt.pending.delete(pending));
  return pending;
}
