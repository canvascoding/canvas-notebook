import 'server-only';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import type { WorkspaceContext } from '../workspaces/types';
import { apiKeyActorId } from '../api-keys/actor';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import type { WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { decodeWorkspaceOperationProgrammaticPlan, type WorkspaceOperationProgrammaticPlan } from './workspace-operation-programmatic-plan';

type Kind = 'move' | 'delete';
type EntryPoint = 'request' | 'mcp';
/** Stored attribution only. It is never a reusable credential or live grant. */
export type WorkspaceOperationApiKeyAuthorization = Readonly<{
  mode: 'api-key'; version: 1; kind: Kind; integrationId: string; instanceId: string; credentialId: string;
  entryPoint: EntryPoint; actorUserId: string; actorId: string; actorType: 'agent'; actorDisplayName: 'API integration';
  actorSessionId: null; requestHash: string; jobScope: WorkspaceOperationJobScope;
}>;
export type WorkspaceOperationApiKeyAuthorizationCurrent = Readonly<{
  userId: string; integrationId: string; instanceId: string; credentialId: string;
  entryPoint: EntryPoint; workspace: WorkspaceContext; kind: Kind;
}>;
type Code = 'API_KEY_JOB_AUTHORIZATION_INVALID' | 'API_KEY_JOB_AUTHORIZATION_TOO_LARGE' | 'API_KEY_JOB_AUTHORIZATION_CHANGED';
export class WorkspaceOperationApiKeyAuthorizationError extends Error {
  readonly status: 400 | 409 | 413;
  constructor(readonly code: Code) {
    super(code); this.name = 'WorkspaceOperationApiKeyAuthorizationError';
    this.status = code.endsWith('TOO_LARGE') ? 413 : code.endsWith('CHANGED') ? 409 : 400;
  }
}
const currentKeys = ['userId', 'integrationId', 'instanceId', 'credentialId', 'entryPoint', 'workspace', 'kind'] as const;
const storedKeys = ['mode', 'version', 'kind', 'integrationId', 'instanceId', 'credentialId', 'entryPoint',
  'actorUserId', 'actorId', 'actorType', 'actorDisplayName', 'actorSessionId', 'requestHash', 'jobScope'] as const;
function fail(code: Code = 'API_KEY_JOB_AUTHORIZATION_INVALID'): never { throw new WorkspaceOperationApiKeyAuthorizationError(code); }
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length) fail();
  const value: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
    value[key] = property.value;
  }
  return value;
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value) && Buffer.from(value).toString('utf8') === value;
}
function isKind(value: unknown): value is Kind { return value === 'move' || value === 'delete'; }
function isEntry(value: unknown): value is EntryPoint { return value === 'request' || value === 'mcp'; }
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'API_KEY_JOB_AUTHORIZATION_TOO_LARGE' : 'API_KEY_JOB_AUTHORIZATION_INVALID'));
}
function scope(input: unknown): WorkspaceOperationJobScope {
  let selected: WorkspaceOperationJobScope;
  try { selected = parseWorkspaceOperationJobScope(capture(input)); }
  catch (error) { if (error instanceof WorkspaceOperationApiKeyAuthorizationError) throw error; return fail(); }
  if (selected.legacy || selected.rootRelativePath === null || Object.values(selected).some(value => typeof value === 'string'
    && Buffer.from(value).toString('utf8') !== value)) fail();
  return selected;
}
function current(input: unknown, keys: readonly string[] = currentKeys) {
  const value = record(input, keys);
  if (!id(value.userId) || !id(value.integrationId) || !id(value.instanceId) || !id(value.credentialId)
    || !isEntry(value.entryPoint) || !isKind(value.kind) || !value.workspace || typeof value.workspace !== 'object'
    || types.isProxy(value.workspace) || Object.getPrototypeOf(value.workspace) !== Object.prototype) fail();
  let jobScope: WorkspaceOperationJobScope;
  try { jobScope = scope(captureWorkspaceOperationJobScope(value.workspace as WorkspaceContext)); }
  catch (error) { if (error instanceof WorkspaceOperationApiKeyAuthorizationError) throw error; return fail(); }
  return Object.freeze({ userId: value.userId, integrationId: value.integrationId, instanceId: value.instanceId,
    credentialId: value.credentialId, entryPoint: value.entryPoint, kind: value.kind, jobScope, planInput: value.plan });
}
function plan(input: unknown, kind: Kind, jobScope: WorkspaceOperationJobScope): WorkspaceOperationProgrammaticPlan {
  return decodeWorkspaceOperationProgrammaticPlan(input, kind, jobScope, reason => fail(reason === 'too-large'
    ? 'API_KEY_JOB_AUTHORIZATION_TOO_LARGE' : 'API_KEY_JOB_AUTHORIZATION_INVALID'));
}
function requestHash(original: Pick<WorkspaceOperationApiKeyAuthorization, 'kind' | 'actorUserId' | 'integrationId'
  | 'instanceId' | 'credentialId' | 'entryPoint' | 'jobScope'>, nativePlan: WorkspaceOperationProgrammaticPlan): string {
  return nativeLinkJsonProof({ protocol: 'workspace-path-operation-api-key-v1', kind: original.kind,
    actorUserId: original.actorUserId, integrationId: original.integrationId, instanceId: original.instanceId,
    credentialId: original.credentialId, entryPoint: original.entryPoint, jobScope: original.jobScope, plan: nativePlan });
}

/** Exact, bounded, sessionless metadata. Caller-supplied permission, key, token
 * and OAuth fields are rejected before any value getter or serializer runs. */
export function decodeWorkspaceOperationApiKeyAuthorization(input: unknown): WorkspaceOperationApiKeyAuthorization {
  const value = record(input, storedKeys);
  if (value.mode !== 'api-key' || value.version !== 1 || !isKind(value.kind) || !isEntry(value.entryPoint)
    || ![value.actorUserId, value.integrationId, value.instanceId, value.credentialId].every(id)
    || value.actorType !== 'agent' || value.actorSessionId !== null || value.actorDisplayName !== 'API integration'
    || typeof value.actorId !== 'string' || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestHash)) fail();
  const userId = value.actorUserId as string, integrationId = value.integrationId as string, instanceId = value.instanceId as string;
  if (value.actorId !== apiKeyActorId({ userId, integrationId, instanceId })) fail();
  const selected: WorkspaceOperationApiKeyAuthorization = Object.freeze({ mode: 'api-key', version: 1,
    kind: value.kind, integrationId, instanceId, credentialId: value.credentialId as string, entryPoint: value.entryPoint,
    actorUserId: userId, actorId: value.actorId, actorType: 'agent', actorDisplayName: 'API integration', actorSessionId: null,
    requestHash: value.requestHash, jobScope: scope(value.jobScope) });
  if (Buffer.byteLength(JSON.stringify(selected)) > 32 * 1024) fail('API_KEY_JOB_AUTHORIZATION_TOO_LARGE');
  return selected;
}

/** Invoke inside an actual fixed key phase. This function captures comparison
 * data only; a workspace or stored DTO cannot authenticate a job. */
export function createWorkspaceOperationApiKeyAuthorization(input: WorkspaceOperationApiKeyAuthorizationCurrent
  & Readonly<{ plan: unknown }>): WorkspaceOperationApiKeyAuthorization {
  const value = current(input, [...currentKeys, 'plan']), nativePlan = plan(value.planInput, value.kind, value.jobScope);
  const original = { kind: value.kind, actorUserId: value.userId, integrationId: value.integrationId, instanceId: value.instanceId,
    credentialId: value.credentialId, entryPoint: value.entryPoint, jobScope: value.jobScope };
  return decodeWorkspaceOperationApiKeyAuthorization({ mode: 'api-key', version: 1, ...original,
    actorId: apiKeyActorId(value), actorType: 'agent', actorDisplayName: 'API integration', actorSessionId: null,
    requestHash: requestHash(original, nativePlan) });
}

/** Current authority is checked separately by the genuine key phase. A rotated
 * key or another permitted entry point retains the exact original attribution. */
export function assertWorkspaceOperationApiKeyAuthorizationCurrent(original: unknown,
  input: WorkspaceOperationApiKeyAuthorizationCurrent, nativePlan: unknown): WorkspaceOperationApiKeyAuthorization {
  const bound = decodeWorkspaceOperationApiKeyAuthorization(original), value = current(input);
  if (bound.actorUserId !== value.userId || bound.integrationId !== value.integrationId || bound.instanceId !== value.instanceId
    || bound.kind !== value.kind || !isDeepStrictEqual(bound.jobScope, value.jobScope)) fail('API_KEY_JOB_AUTHORIZATION_CHANGED');
  const selected = plan(nativePlan, value.kind, value.jobScope);
  if (bound.requestHash !== requestHash(bound, selected)) fail('API_KEY_JOB_AUTHORIZATION_CHANGED');
  return bound;
}

/** Stable integration/user/instance/workspace/action namespace. Current key ID
 * and HTTP/MCP entry point never change the caller's operation identity. */
export function workspaceOperationApiKeyBatchId(input: Readonly<{ userId: string; integrationId: string; instanceId: string;
  workspaceId: string; kind: Kind; operationId: string }>): string {
  const value = record(input, ['userId', 'integrationId', 'instanceId', 'workspaceId', 'kind', 'operationId']);
  if (![value.userId, value.integrationId, value.instanceId, value.workspaceId].every(id) || !isKind(value.kind)
    || typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.operationId)) fail();
  return createHash('sha256').update(JSON.stringify(['workspace-path-operation-api-key-id-v1', value.userId,
    value.integrationId, value.instanceId, value.workspaceId, value.kind, value.operationId])).digest('hex');
}
