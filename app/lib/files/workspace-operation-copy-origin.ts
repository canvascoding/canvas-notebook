import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import type { WorkspaceContext } from '../workspaces/types';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { apiKeyActorId } from '../api-keys/actor';

export type WorkspaceOperationCopyActor = Readonly<{
  type: 'user' | 'agent'; userId: string; actorId: string; sessionId: string | null;
}>;
/** Original request data only. This is neither a current principal nor a grant. */
export type WorkspaceOperationCopyLegacyOrigin = Readonly<{
  version: 1; actor: WorkspaceOperationCopyActor;
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
}>;
/** MCP attribution is explicit. An agent-shaped actor alone must never select
 * PI authority. These scalars describe history, not a live OAuth grant. */
export type WorkspaceOperationCopyMcpOrigin = Readonly<{
  version: 2; transport: 'direct-mcp'; clientId: string;
  actor: WorkspaceOperationCopyActor;
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
}>;
/** API-key provenance is explicit and contains no login session or secret.
 * Stable integration ownership survives rotation; credential/entry-point facts
 * remain those of the original operation. This record grants no authority. */
export type WorkspaceOperationCopyApiKeyOrigin = Readonly<{
  version: 3; transport: 'api-key'; integrationId: string; instanceId: string;
  credentialId: string; entryPoint: 'request' | 'mcp'; actor: WorkspaceOperationCopyActor;
  sourceScope: WorkspaceOperationJobScope; destinationScope: WorkspaceOperationJobScope;
}>;
export type WorkspaceOperationCopyOrigin = WorkspaceOperationCopyLegacyOrigin | WorkspaceOperationCopyMcpOrigin | WorkspaceOperationCopyApiKeyOrigin;
type CaptureInput = Readonly<{
  actor: WorkspaceOperationCopyActor; sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext;
}>;
type McpCaptureInput = Readonly<{
  userId: string; clientId: string; sessionId: string;
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext;
}>;
type ApiKeyCaptureInput = Readonly<{
  userId: string; integrationId: string; instanceId: string; credentialId: string; entryPoint: 'request' | 'mcp';
  sourceWorkspace: WorkspaceContext; destinationWorkspace: WorkspaceContext;
}>;

export class WorkspaceOperationCopyOriginError extends Error {
  readonly status = 409;
  constructor(readonly code: 'COPY_ORIGIN_INVALID' | 'COPY_ORIGIN_CHANGED') {
    super(code); this.name = 'WorkspaceOperationCopyOriginError';
  }
}
function invalid(): never { throw new WorkspaceOperationCopyOriginError('COPY_ORIGIN_INVALID'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
}
function mcpActorId(clientId: string): string {
  return `direct-mcp:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
}

export function decodeWorkspaceOperationCopyOrigin(input: unknown): WorkspaceOperationCopyOrigin {
  const detached = captureWorkspaceOperationNativePlanData(input, invalid);
  const version = detached && typeof detached === 'object'
    ? Object.getOwnPropertyDescriptor(detached, 'version')?.value : undefined;
  const value = record(detached, version === 3
    ? ['version', 'transport', 'integrationId', 'instanceId', 'credentialId', 'entryPoint', 'actor', 'sourceScope', 'destinationScope']
    : version === 2
    ? ['version', 'transport', 'clientId', 'actor', 'sourceScope', 'destinationScope']
    : ['version', 'actor', 'sourceScope', 'destinationScope']);
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024 || ![1, 2, 3].includes(value.version as number)) invalid();
  const actor = record(value.actor, ['type', 'userId', 'actorId', 'sessionId']);
  if (actor.type !== 'user' && actor.type !== 'agent' || !id(actor.userId) || !id(actor.actorId)
    || actor.type === 'user' && actor.actorId !== actor.userId
    || actor.sessionId !== null && !id(actor.sessionId)) invalid();
  if (value.version === 2 && (value.transport !== 'direct-mcp' || !id(value.clientId)
    || value.clientId !== value.clientId.trim() || actor.userId !== actor.userId.trim()
    || actor.type !== 'agent' || !id(actor.sessionId) || actor.sessionId !== actor.sessionId.trim()
    || actor.actorId !== mcpActorId(value.clientId))) invalid();
  if (value.version === 3 && (value.transport !== 'api-key'
    || ![value.integrationId, value.instanceId, value.credentialId, actor.userId].every(value => id(value) && value === value.trim())
    || value.entryPoint !== 'request' && value.entryPoint !== 'mcp' || actor.type !== 'agent' || actor.sessionId !== null
    || actor.actorId !== apiKeyActorId({ userId: actor.userId, integrationId: value.integrationId as string,
      instanceId: value.instanceId as string }))) invalid();
  let sourceScope: WorkspaceOperationJobScope, destinationScope: WorkspaceOperationJobScope;
  try {
    sourceScope = parseWorkspaceOperationJobScope(value.sourceScope);
    destinationScope = parseWorkspaceOperationJobScope(value.destinationScope);
  } catch { return invalid(); }
  if ([...Object.values(sourceScope), ...Object.values(destinationScope)].some(value =>
    typeof value === 'string' && Buffer.from(value).toString('utf8') !== value)) invalid();
  if (sourceScope.workspaceId === destinationScope.workspaceId && !isDeepStrictEqual(sourceScope, destinationScope)) invalid();
  const result = { actor: Object.freeze({ type: actor.type as 'user' | 'agent', userId: actor.userId,
    actorId: actor.actorId, sessionId: actor.sessionId as string | null }), sourceScope, destinationScope };
  return value.version === 3
    ? Object.freeze({ version: 3, transport: 'api-key', integrationId: value.integrationId as string,
      instanceId: value.instanceId as string, credentialId: value.credentialId as string,
      entryPoint: value.entryPoint as 'request' | 'mcp', ...result })
    : value.version === 2
    ? Object.freeze({ version: 2, transport: 'direct-mcp', clientId: value.clientId as string, ...result })
    : Object.freeze({ version: 1, ...result });
}

/** Capture before awaiting anything; no mutable caller object survives. */
export function captureWorkspaceOperationCopyOrigin(input: CaptureInput): WorkspaceOperationCopyOrigin {
  const fields = record(input, ['actor', 'sourceWorkspace', 'destinationWorkspace']);
  try {
    return decodeWorkspaceOperationCopyOrigin({ version: 1, actor: fields.actor,
      sourceScope: captureWorkspaceOperationJobScope(fields.sourceWorkspace as WorkspaceContext),
      destinationScope: captureWorkspaceOperationJobScope(fields.destinationWorkspace as WorkspaceContext) });
  } catch { return invalid(); }
}

/** Detach primitive facts from a genuine MCP phase before any await. Calling
 * this function with a DTO conveys no authorization and retains no bearer. */
export function captureWorkspaceOperationCopyMcpOrigin(input: McpCaptureInput): WorkspaceOperationCopyMcpOrigin {
  if (types.isProxy(input)) invalid();
  const fields = record(input, ['userId', 'clientId', 'sessionId', 'sourceWorkspace', 'destinationWorkspace']);
  if (![fields.userId, fields.clientId, fields.sessionId].every(id)
    || types.isProxy(fields.sourceWorkspace) || types.isProxy(fields.destinationWorkspace)) invalid();
  try {
    const origin = decodeWorkspaceOperationCopyOrigin({ version: 2, transport: 'direct-mcp', clientId: fields.clientId,
      actor: { type: 'agent', userId: fields.userId, actorId: mcpActorId(fields.clientId as string), sessionId: fields.sessionId },
      sourceScope: captureWorkspaceOperationJobScope(fields.sourceWorkspace as WorkspaceContext),
      destinationScope: captureWorkspaceOperationJobScope(fields.destinationWorkspace as WorkspaceContext) });
    if (origin.version !== 2) invalid();
    return origin;
  } catch { return invalid(); }
}

/** Detach facts from a genuine API-key phase. Even a valid serialized record
 * cannot replace the live, purpose-bound handle required on every actual B. */
export function captureWorkspaceOperationCopyApiKeyOrigin(input: ApiKeyCaptureInput): WorkspaceOperationCopyApiKeyOrigin {
  if (types.isProxy(input)) invalid();
  const fields = record(input, ['userId', 'integrationId', 'instanceId', 'credentialId', 'entryPoint', 'sourceWorkspace', 'destinationWorkspace']);
  if (![fields.userId, fields.integrationId, fields.instanceId, fields.credentialId].every(id)
    || types.isProxy(fields.sourceWorkspace) || types.isProxy(fields.destinationWorkspace)) invalid();
  try {
    const origin = decodeWorkspaceOperationCopyOrigin({ version: 3, transport: 'api-key',
      integrationId: fields.integrationId, instanceId: fields.instanceId, credentialId: fields.credentialId, entryPoint: fields.entryPoint,
      actor: { type: 'agent', userId: fields.userId, actorId: apiKeyActorId({ userId: fields.userId as string,
        integrationId: fields.integrationId as string, instanceId: fields.instanceId as string }), sessionId: null },
      sourceScope: captureWorkspaceOperationJobScope(fields.sourceWorkspace as WorkspaceContext),
      destinationScope: captureWorkspaceOperationJobScope(fields.destinationWorkspace as WorkspaceContext) });
    if (origin.version !== 3) invalid();
    return origin;
  } catch { return invalid(); }
}

/** Fresh authorization remains the caller's responsibility. A new current
 * session never replaces the original receipt session stored in origin. */
export function assertWorkspaceOperationCopyOriginCurrent(origin: unknown,
  current: WorkspaceOperationCopyOrigin): WorkspaceOperationCopyOrigin {
  const original = decodeWorkspaceOperationCopyOrigin(origin), fresh = decodeWorkspaceOperationCopyOrigin(current);
  if (original.version !== fresh.version
    || original.version === 2 && (fresh.version !== 2 || original.clientId !== fresh.clientId)
    || original.version === 3 && (fresh.version !== 3 || original.integrationId !== fresh.integrationId || original.instanceId !== fresh.instanceId)
    || original.actor.type !== fresh.actor.type || original.actor.userId !== fresh.actor.userId
    || original.actor.actorId !== fresh.actor.actorId || !isDeepStrictEqual(original.sourceScope, fresh.sourceScope)
    || !isDeepStrictEqual(original.destinationScope, fresh.destinationScope)) {
    throw new WorkspaceOperationCopyOriginError('COPY_ORIGIN_CHANGED');
  }
  return original;
}
