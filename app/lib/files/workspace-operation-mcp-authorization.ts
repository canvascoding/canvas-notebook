import { decodeWorkspaceOperationDeleteBatchPlan } from './workspace-operation-delete-plan-dispatch';
import type { WorkspaceOperationDeleteBatchPlan } from './workspace-operation-batch-contract';
import 'server-only';
import { WorkspaceOperationPhysicalDeleteHtmlPlanError } from './workspace-operation-physical-delete-html-plan-v5';

import { createHash } from 'node:crypto';
import { isDeepStrictEqual, types } from 'node:util';
import type { WorkspaceContext } from '../workspaces/types';
import { nativeLinkJsonProof } from '../markdown/workspace-native-link-inventory';
import type { WorkspaceOperationDirectMcpAuthorization, WorkspaceOperationJobScope } from './workspace-operation-batch-contract';
import { captureWorkspaceOperationJobScope, parseWorkspaceOperationJobScope } from './workspace-operation-job-scope';
import { captureWorkspaceOperationNativePlanData } from './workspace-operation-native-plan-data';
import { decodeWorkspaceOperationNativeMoveBatchPlan, WorkspaceOperationNativeMovePlanError,
  type WorkspaceOperationNativeMoveBatchPlan } from './workspace-operation-native-move-plan';
import { WorkspaceOperationNativeDeletePlanError } from './workspace-operation-native-delete-plan';
import { WorkspaceOperationNativeSourceEvidenceError } from './workspace-operation-native-source-evidence';

type Tool = WorkspaceOperationDirectMcpAuthorization['tool'];
type NativePlan = WorkspaceOperationNativeMoveBatchPlan | WorkspaceOperationDeleteBatchPlan;
export type WorkspaceOperationMcpAuthorizationCurrent = Readonly<{
  userId: string; clientId: string; sessionId: string; workspace: WorkspaceContext; tool: Tool;
}>;
type Code = 'MCP_JOB_AUTHORIZATION_INVALID' | 'MCP_JOB_AUTHORIZATION_TOO_LARGE' | 'MCP_JOB_AUTHORIZATION_CHANGED';
export class WorkspaceOperationMcpAuthorizationError extends Error {
  readonly status: 400 | 409 | 413;
  constructor(readonly code: Code) {
    super(code); this.name = 'WorkspaceOperationMcpAuthorizationError';
    this.status = code === 'MCP_JOB_AUTHORIZATION_TOO_LARGE' ? 413 : code === 'MCP_JOB_AUTHORIZATION_CHANGED' ? 409 : 400;
  }
}
const authorizationKeys = ['mode', 'version', 'tool', 'clientId', 'actorUserId', 'actorId', 'actorType',
  'actorDisplayName', 'actorSessionId', 'requestHash', 'jobScope'] as const;
const currentKeys = ['userId', 'clientId', 'sessionId', 'workspace', 'tool'] as const;
function fail(code: Code = 'MCP_JOB_AUTHORIZATION_INVALID'): never { throw new WorkspaceOperationMcpAuthorizationError(code); }

function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length !== keys.length) fail();
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(input, key);
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail();
    captured[key] = property.value;
  }
  return captured;
}
function id(input: unknown): input is string {
  return typeof input === 'string' && input.length > 0 && input.length <= 256 && input === input.trim()
    && !/[\u0000-\u001f\u007f]/u.test(input) && Buffer.from(input).toString('utf8') === input;
}
function tool(input: unknown): input is Tool { return input === 'move_knowledge_source' || input === 'delete_knowledge_source'; }
const actorId = (clientId: string): string => `direct-mcp:${createHash('sha256').update(clientId).digest('hex').slice(0, 32)}`;
function capture(input: unknown): unknown {
  return captureWorkspaceOperationNativePlanData(input, reason => fail(reason === 'too-large'
    ? 'MCP_JOB_AUTHORIZATION_TOO_LARGE' : 'MCP_JOB_AUTHORIZATION_INVALID'));
}
function scope(input: unknown): WorkspaceOperationJobScope {
  let parsed: WorkspaceOperationJobScope;
  try { parsed = parseWorkspaceOperationJobScope(capture(input)); }
  catch (error) { if (error instanceof WorkspaceOperationMcpAuthorizationError) throw error; return fail(); }
  if (parsed.legacy || parsed.rootRelativePath === null || Object.values(parsed).some(value => typeof value === 'string'
    && Buffer.from(value).toString('utf8') !== value)) fail();
  return parsed;
}
function current(input: unknown, keys: readonly string[] = currentKeys): Readonly<{
  userId: string; clientId: string; sessionId: string; tool: Tool; jobScope: WorkspaceOperationJobScope; planInput: unknown;
}> {
  const selected = record(input, keys);
  if (!id(selected.userId) || !id(selected.clientId) || !id(selected.sessionId) || !tool(selected.tool)
    || !selected.workspace || typeof selected.workspace !== 'object' || types.isProxy(selected.workspace)
    || Object.getPrototypeOf(selected.workspace) !== Object.prototype) fail();
  let jobScope: WorkspaceOperationJobScope;
  try {
    // This projection reads only own namespace descriptors. Permissions, actor,
    // status and display fields are neither inspected nor treated as authority.
    jobScope = scope(captureWorkspaceOperationJobScope(selected.workspace as WorkspaceContext));
  } catch (error) { if (error instanceof WorkspaceOperationMcpAuthorizationError) throw error; return fail(); }
  return { userId: selected.userId, clientId: selected.clientId, sessionId: selected.sessionId,
    tool: selected.tool, jobScope, planInput: selected.plan };
}
function plan(input: unknown, selectedTool: Tool, jobScope: WorkspaceOperationJobScope): NativePlan {
  const data = capture(input);
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail();
  const version = Object.getOwnPropertyDescriptor(data, 'version')?.value;
  let selected: NativePlan;
  try {
    if (version === 3 && selectedTool === 'move_knowledge_source') selected = decodeWorkspaceOperationNativeMoveBatchPlan(data);
    else if ((version === 2 || version === 5) && selectedTool === 'delete_knowledge_source') selected = decodeWorkspaceOperationDeleteBatchPlan(data);
    else return fail();
  } catch (error) {
    if ((error instanceof WorkspaceOperationNativeMovePlanError || error instanceof WorkspaceOperationNativeDeletePlanError
      || error instanceof WorkspaceOperationNativeSourceEvidenceError || error instanceof WorkspaceOperationPhysicalDeleteHtmlPlanError) && error.code.endsWith('_TOO_LARGE')) {
      fail('MCP_JOB_AUTHORIZATION_TOO_LARGE');
    }
    return fail();
  }
  if (selected.workspaceId !== jobScope.workspaceId || !isDeepStrictEqual(selected.sourceEvidence.workspaceScope, jobScope)
    || selectedTool === 'move_knowledge_source' && !['move', 'rename'].includes(selected.actions[0].kind)
    || selectedTool === 'delete_knowledge_source' && selected.actions[0].kind !== 'delete') fail();
  return selected;
}
function requestHash(selected: Pick<WorkspaceOperationMcpAuthorizationCurrent, 'userId' | 'clientId' | 'tool'>,
  jobScope: WorkspaceOperationJobScope, nativePlan: NativePlan): string {
  // Only detached, fully decoded native data reaches the canonical serializer.
  // Full historical plan integrity is included, not merely its semantic ID.
  return nativeLinkJsonProof({ protocol: 'workspace-path-operation-direct-mcp-v1',
    clientId: selected.clientId, actorUserId: selected.userId, tool: selected.tool, jobScope, plan: nativePlan });
}

/** Stored Original-A facts only. No token, principal, permission or live grant. */
export function decodeWorkspaceOperationMcpAuthorization(input: unknown): WorkspaceOperationDirectMcpAuthorization {
  const value = record(input, authorizationKeys);
  if (value.mode !== 'direct-mcp' || value.version !== 1 || !tool(value.tool) || !id(value.clientId)
    || !id(value.actorUserId) || !id(value.actorSessionId) || !id(value.actorId) || value.actorType !== 'agent'
    || value.actorId !== actorId(value.clientId) || value.actorDisplayName !== 'MCP client'
    || typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestHash)) fail();
  const jobScope = scope(value.jobScope);
  const result: WorkspaceOperationDirectMcpAuthorization = Object.freeze({ mode: 'direct-mcp', version: 1,
    tool: value.tool, clientId: value.clientId, actorUserId: value.actorUserId, actorId: value.actorId,
    actorType: 'agent', actorDisplayName: 'MCP client', actorSessionId: value.actorSessionId,
    requestHash: value.requestHash, jobScope });
  if (Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) fail('MCP_JOB_AUTHORIZATION_TOO_LARGE');
  return result;
}

/** Call synchronously inside a genuine current MCP phase. This function only
 * captures data; calling it with a workspace DTO grants no access or effect. */
export function createWorkspaceOperationMcpAuthorization(input: WorkspaceOperationMcpAuthorizationCurrent & Readonly<{
  plan: unknown;
}>): WorkspaceOperationDirectMcpAuthorization {
  const selected = current(input, [...currentKeys, 'plan']);
  const nativePlan = plan(selected.planInput, selected.tool, selected.jobScope);
  return decodeWorkspaceOperationMcpAuthorization({ mode: 'direct-mcp', version: 1, tool: selected.tool,
    clientId: selected.clientId, actorUserId: selected.userId, actorId: actorId(selected.clientId), actorType: 'agent',
    actorDisplayName: 'MCP client', actorSessionId: selected.sessionId,
    requestHash: requestHash(selected, selected.jobScope, nativePlan), jobScope: selected.jobScope });
}

/** Fresh current rights are checked by the genuine principal/owner separately.
 * Renewed SID-B may continue Original-A but never rewrites its attribution. */
export function assertWorkspaceOperationMcpAuthorizationCurrent(original: unknown,
  input: WorkspaceOperationMcpAuthorizationCurrent, nativePlan: unknown): WorkspaceOperationDirectMcpAuthorization {
  const bound = decodeWorkspaceOperationMcpAuthorization(original), selected = current(input);
  if (bound.clientId !== selected.clientId || bound.actorUserId !== selected.userId || bound.tool !== selected.tool
    || !isDeepStrictEqual(bound.jobScope, selected.jobScope)) fail('MCP_JOB_AUTHORIZATION_CHANGED');
  const decoded = plan(nativePlan, selected.tool, selected.jobScope);
  if (bound.requestHash !== requestHash(selected, selected.jobScope, decoded)) fail('MCP_JOB_AUTHORIZATION_CHANGED');
  return bound;
}

/** Caller key namespaces include actual client/user/workspace/fixed tool. They
 * intentionally omit the current session and preserve operation-key case. */
export function workspaceOperationMcpBatchId(input: Readonly<{
  userId: string; clientId: string; workspaceId: string; tool: Tool; operationId: string;
}>): string {
  const value = record(input, ['userId', 'clientId', 'workspaceId', 'tool', 'operationId']);
  if (!id(value.userId) || !id(value.clientId) || !id(value.workspaceId) || !tool(value.tool)
    || typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/u.test(value.operationId)) fail();
  return createHash('sha256').update(JSON.stringify(['workspace-path-operation-direct-mcp-id-v1', value.userId,
    value.clientId, value.workspaceId, value.tool, value.operationId])).digest('hex');
}
