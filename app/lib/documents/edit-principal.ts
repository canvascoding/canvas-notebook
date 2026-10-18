import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import { NextRequest } from 'next/server';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { SqlConnection } from '../db';
import { withDirectMcpDocumentEditPrincipal, withDirectMcpDocumentEditPrincipalOnConnection,
  type DirectMcpDocumentEditCurrentOrigin } from '../mcp/server/document-read-principal';
import { withPreparedDocumentEditToolPolicy } from '../public-sharing/tool-policy';
import { withWorkspaceRequestPrincipalOriginalOrigin, withWorkspaceRequestPrincipalOnConnection,
  withWorkspaceAgentToolPrincipalOriginalOrigin, withWorkspaceAgentToolPrincipalOnConnection,
  assertWorkspaceNativeEditRequestPrincipalActiveOnConnection, assertWorkspaceNativeEditAgentPrincipalActiveOnConnection,
  type WorkspaceRequestHistoricalOrigin, type WorkspaceAgentToolHistoricalOrigin } from '../workspaces/request-principal';
import type { WorkspaceContext } from '../workspaces/types';
import { DocumentEditError } from './edit-contracts';

declare const authorityBrand: unique symbol;
/** Only a fixed real transport factory registers this non-serializable handle. */
export type NativeDocumentEditWriteAuthority = Readonly<{ [authorityBrand]: never }>;
/** Current invocation facts. A stored operation's original origin is separate. */
export type NativeDocumentEditAuthorityOrigin = Readonly<
  WorkspaceRequestHistoricalOrigin & { transport: 'request' }
  | DirectMcpDocumentEditCurrentOrigin & { transport: 'direct-mcp' }
  | WorkspaceAgentToolHistoricalOrigin & { transport: 'agent-tool' }
>;
export type NativeDocumentEditWriteAuthorityAccess = Readonly<{
  workspace: WorkspaceContext; userId: string; actorType: 'user' | 'agent'; actorId: string;
  actorDisplayName: string; sessionId: string; origin: NativeDocumentEditAuthorityOrigin;
  assertCurrent: () => Promise<void>; assertActive: () => void;
}>;
type SourceAccess = NativeDocumentEditWriteAuthorityAccess;
type Dispatcher = <T>(connection: SqlConnection, consume: (access: SourceAccess) => Promise<T>) => Promise<T>;
type Capture = {
  active: boolean; accepting: boolean; busy: boolean; failure?: unknown;
  pending: Set<Promise<unknown>>; workspaceId: string; dispatch: Dispatcher; phase?: Phase;
};
type Phase = {
  capture: Capture; connection: SqlConnection; active: boolean; accepting: boolean; checking: boolean;
  failure?: unknown; pending: Set<Promise<unknown>>; source?: SourceAccess; access?: NativeDocumentEditWriteAuthorityAccess;
};
type Registry = Readonly<{ version: 1;
  authorities: WeakMap<NativeDocumentEditWriteAuthority, Capture>; phases: WeakMap<SqlConnection, Phase>;
  storage: AsyncLocalStorage<Phase> }>;
const registryKey = Symbol.for('canvas.native-document-edit-write-authorities.v1');

function failure(code: ConstructorParameters<typeof DocumentEditError>[0]): never { throw new DocumentEditError(code); }
function reason(error: unknown): unknown { return error ?? new DocumentEditError('DOCUMENT_EDIT_UNAVAILABLE'); }
/** Next and the standalone server share identity, never a serialized grant.
 * Actual tokens/principals stay in their original factory's private closure. */
function registry(): Registry {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, registryKey);
  if (!descriptor) {
    const created: Registry = Object.freeze({ version: 1,
      authorities: new WeakMap<NativeDocumentEditWriteAuthority, Capture>(),
      phases: new WeakMap<SqlConnection, Phase>(), storage: new AsyncLocalStorage<Phase>() });
    Object.defineProperty(globalThis, registryKey, { value: created });
    return created;
  }
  if (!Object.hasOwn(descriptor, 'value')) failure('DOCUMENT_EDIT_UNAVAILABLE');
  const value: unknown = descriptor.value;
  if (!value || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    failure('DOCUMENT_EDIT_UNAVAILABLE');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== 4 || !['version', 'authorities', 'phases', 'storage'].every(key =>
    properties[key]?.enumerable && Object.hasOwn(properties[key], 'value'))
    || properties.version.value !== 1 || !types.isWeakMap(properties.authorities.value)
    || !types.isWeakMap(properties.phases.value) || !(properties.storage.value instanceof AsyncLocalStorage)) failure('DOCUMENT_EDIT_UNAVAILABLE');
  return value as Registry;
}
const shared = registry();

function workspaceId(options: { workspaceId: string }): string {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Object.getPrototypeOf(options) !== Object.prototype) failure('INVALID_REQUEST');
  const descriptors = Object.getOwnPropertyDescriptors(options), descriptor = descriptors.workspaceId;
  if (Reflect.ownKeys(descriptors).length !== 1 || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) failure('INVALID_REQUEST');
  const value: unknown = descriptor.value;
  if (typeof value !== 'string' || !value || value.length > 256 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.from(value).toString('utf8') !== value) failure('INVALID_REQUEST');
  return value;
}
function observe(record: { value?: NativeDocumentEditAuthorityOrigin }, origin: NativeDocumentEditAuthorityOrigin): void {
  if (record.value && !isDeepStrictEqual(record.value, origin)) failure('DOCUMENT_SCOPE_CHANGED');
  record.value ??= Object.freeze(origin);
}
function observed(record: { value?: NativeDocumentEditAuthorityOrigin }, transport: NativeDocumentEditAuthorityOrigin['transport'],
  workspace: WorkspaceContext): NativeDocumentEditAuthorityOrigin {
  const value = record.value;
  if (!value || value.transport !== transport || value.workspaceId !== workspace.workspaceId
    || workspace.legacy !== false || workspace.status !== 'active' || !workspace.permissions.canRead || !workspace.permissions.canWrite) {
    failure('ACCESS_DENIED');
  }
  return value;
}
function poison(phase: Phase, error: unknown): never {
  phase.failure ??= reason(error); phase.capture.failure ??= phase.failure; throw phase.failure;
}
function active(phase: Phase, allowCheck = false): void {
  if (!phase.active || !phase.accepting || !phase.capture.active || !phase.capture.accepting
    || shared.phases.get(phase.connection) !== phase || shared.storage.getStore() !== phase) failure('AUTHENTICATION_REQUIRED');
  if (phase.failure !== undefined) throw phase.failure;
  if (phase.capture.failure !== undefined) throw phase.capture.failure;
  if (!allowCheck && (phase.checking || phase.pending.size)) failure('DOCUMENT_SCOPE_CHANGED');
  if (!phase.source) failure('AUTHENTICATION_REQUIRED');
  phase.source.assertActive();
}
/** Returns only active genuine handles. The empty object/JSON shape proves nothing. */
export function isNativeDocumentEditWriteAuthority(value: unknown): value is NativeDocumentEditWriteAuthority {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return false;
  const captured = shared.authorities.get(value as NativeDocumentEditWriteAuthority);
  return !!captured?.active && captured.accepting && captured.failure === undefined;
}

/** Fixed final guard after expensive CAS/target preflight, before the first
 * actual Yjs write. It cannot create or extend a B phase. */
export function assertNativeDocumentEditWriteAuthorityActive(authority: NativeDocumentEditWriteAuthority): void {
  const capture = shared.authorities.get(authority), phase = capture?.phase, held = shared.storage.getStore();
  try {
    if (!capture || !phase || held !== phase || phase.capture !== capture || !phase.access) failure('AUTHENTICATION_REQUIRED');
    phase.access.assertActive();
  } catch (error) {
    if (capture) capture.failure ??= reason(error);
    if (held) { held.failure ??= reason(error); held.capture.failure ??= held.failure; }
    throw capture?.failure ?? reason(error);
  }
}

async function retain<T>(selectedWorkspaceId: string, dispatch: Dispatcher,
  consume: (authority: NativeDocumentEditWriteAuthority) => Promise<T>): Promise<T> {
  const handle = Object.freeze({}) as NativeDocumentEditWriteAuthority;
  const capture: Capture = { workspaceId: selectedWorkspaceId, dispatch, active: true, accepting: true, busy: false, pending: new Set() };
  shared.authorities.set(handle, capture);
  try {
    let value: T | undefined, operationFailure: unknown;
    try { value = await consume(handle); }
    catch (error) { operationFailure = reason(error); capture.failure ??= operationFailure; }
    capture.accepting = false;
    if (capture.pending.size) {
      capture.failure ??= new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
      await Promise.allSettled([...capture.pending]);
    }
    if (operationFailure !== undefined) throw operationFailure;
    if (capture.failure !== undefined) throw capture.failure;
    return value as T;
  } finally { capture.active = false; capture.accepting = false; shared.authorities.delete(handle); }
}

/** No BEGIN/COMMIT/close. Enter only after workspace+room admission; finish and
 * settle caller B before store/disconnect. Never retain this access over queues. */
export function withNativeDocumentEditWriteAuthorityOnConnection<T>(connection: SqlConnection,
  authority: NativeDocumentEditWriteAuthority,
  consume: (access: NativeDocumentEditWriteAuthorityAccess) => Promise<T>): Promise<T> {
  const capture = shared.authorities.get(authority), held = shared.phases.get(connection);
  let inputFailure: unknown;
  if (!capture?.active || !capture.accepting) inputFailure = new DocumentEditError('AUTHENTICATION_REQUIRED');
  else if (capture.failure !== undefined) inputFailure = capture.failure;
  else if (capture.busy || held) inputFailure = new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
  else if (!connection || typeof connection !== 'object' || typeof consume !== 'function') inputFailure = new DocumentEditError('INVALID_REQUEST');
  if (inputFailure !== undefined) {
    if (capture) capture.failure ??= inputFailure;
    if (held) { held.failure ??= inputFailure; held.capture.failure ??= held.failure; }
    return Promise.reject(inputFailure);
  }
  // The live capture was just established from the private register.
  const captured = capture!;
  captured.busy = true;
  const phase: Phase = { capture: captured, connection, active: true, accepting: true, checking: false, pending: new Set() };
  shared.phases.set(connection, phase);
  const pending = Promise.resolve().then(() => captured.dispatch(connection, source => shared.storage.run(phase, async () => {
    phase.source = source;
    try {
      if (source.workspace.workspaceId !== captured.workspaceId) failure('DOCUMENT_SCOPE_CHANGED');
      active(phase);
      const assertActive = (): void => { try { active(phase); } catch (error) { poison(phase, error); } };
      const assertCurrent = (): Promise<void> => {
        try { active(phase); } catch (error) { try { poison(phase, error); } catch (failure) { return Promise.reject(failure); } }
        phase.checking = true;
        const check = (async () => {
          try { await source.assertCurrent(); active(phase, true); }
          catch (error) { poison(phase, error); }
          finally { phase.checking = false; }
        })();
        phase.pending.add(check);
        void check.then(() => phase.pending.delete(check), () => phase.pending.delete(check));
        return check;
      };
      const access: NativeDocumentEditWriteAuthorityAccess = Object.freeze({
        workspace: source.workspace, userId: source.userId, actorType: source.actorType, actorId: source.actorId,
        actorDisplayName: source.actorDisplayName, sessionId: source.sessionId, origin: source.origin, assertCurrent, assertActive });
      phase.access = access; captured.phase = phase;
      try { return await consume(access); }
      finally {
        phase.access = undefined;
        if (captured.phase === phase) captured.phase = undefined;
        phase.accepting = false;
        if (phase.pending.size) {
          phase.failure ??= new DocumentEditError('DOCUMENT_SCOPE_CHANGED'); captured.failure ??= phase.failure;
          await Promise.allSettled([...phase.pending]);
        }
        if (phase.failure !== undefined) throw phase.failure;
      }
    } catch (error) { poison(phase, error); }
  }))).catch(error => poison(phase, error)).finally(() => {
    phase.active = false; phase.accepting = false; captured.busy = false;
    if (shared.phases.get(connection) === phase) shared.phases.delete(connection);
  });
  captured.pending.add(pending);
  void pending.then(() => captured.pending.delete(pending), () => captured.pending.delete(pending));
  return pending;
}

/** Genuine incoming member credentials, copied before the first await. */
export async function withNativeDocumentEditRequestAuthority<T>(request: Request, options: { workspaceId: string },
  consume: (authority: NativeDocumentEditWriteAuthority) => Promise<T>): Promise<T> {
  const selected = workspaceId(options);
  if (!request || types.isProxy(request) || !(request instanceof Request) || typeof consume !== 'function') failure('INVALID_REQUEST');
  const actual = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const current: { value?: NativeDocumentEditAuthorityOrigin } = {};
  return withWorkspaceRequestPrincipalOriginalOrigin(actual, { workspaceId: selected, permission: 'canWrite' },
    origin => observe(current, { ...origin, transport: 'request' }), principal => retain(selected,
      (connection, consumeAccess) => withWorkspaceRequestPrincipalOnConnection(connection, principal, access => consumeAccess(Object.freeze({
        workspace: access.workspace, userId: access.userId, actorType: 'user', actorId: access.userId,
        actorDisplayName: access.userId, sessionId: access.sessionId, origin: observed(current, 'request', access.workspace),
        assertCurrent: access.assertCurrent,
        assertActive: () => assertWorkspaceNativeEditRequestPrincipalActiveOnConnection(connection, principal) }))), consume));
}

/** Actual current MCP token. A prior operation's SID is never an input. */
export async function withNativeDocumentEditMcpAuthority<T>(authInfo: AuthInfo, options: { workspaceId: string },
  consume: (authority: NativeDocumentEditWriteAuthority) => Promise<T>): Promise<T> {
  const selected = workspaceId(options);
  if (typeof consume !== 'function') failure('INVALID_REQUEST');
  const current: { value?: NativeDocumentEditAuthorityOrigin } = {};
  return withDirectMcpDocumentEditPrincipal(authInfo, { workspaceId: selected },
    origin => observe(current, { ...origin, transport: 'direct-mcp' }), principal => retain(selected,
      (connection, consumeAccess) => withDirectMcpDocumentEditPrincipalOnConnection(connection, principal, access => consumeAccess(Object.freeze({
        workspace: access.workspace, userId: access.userId, actorType: 'agent',
        actorId: `direct-mcp:${createHash('sha256').update(access.clientId).digest('hex').slice(0, 32)}`,
        actorDisplayName: access.clientId, sessionId: access.sessionId, origin: observed(current, 'direct-mcp', access.workspace),
        assertCurrent: access.assertCurrent, assertActive: access.assertActive }))), consume));
}

/** Actual wrapped edit_file invocation and freshly checked fixed tool use. */
export async function withNativeDocumentEditPiAuthority<T>(options: { workspaceId: string },
  consume: (authority: NativeDocumentEditWriteAuthority) => Promise<T>): Promise<T> {
  const selected = workspaceId(options);
  if (typeof consume !== 'function') failure('INVALID_REQUEST');
  const current: { value?: NativeDocumentEditAuthorityOrigin } = {};
  return withPreparedDocumentEditToolPolicy(policy => withWorkspaceAgentToolPrincipalOriginalOrigin(
    { workspaceId: selected, permission: 'canWrite' }, origin => observe(current, { ...origin, transport: 'agent-tool' }),
    principal => retain(selected, (connection, consumeAccess) => withWorkspaceAgentToolPrincipalOnConnection(connection, principal, async access => {
      await policy.assertCurrent(connection, access);
      const result = await consumeAccess(Object.freeze({ workspace: access.workspace, userId: access.userId,
        actorType: 'agent', actorId: access.agentId, actorDisplayName: access.agentId, sessionId: access.piSessionId,
        origin: observed(current, 'agent-tool', access.workspace), assertCurrent: () => policy.assertCurrent(connection, access),
        assertActive: () => assertWorkspaceNativeEditAgentPrincipalActiveOnConnection(connection, principal) }));
      await policy.assertCurrent(connection, access);
      return result;
    }), consume)));
}
