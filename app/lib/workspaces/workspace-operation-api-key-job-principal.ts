import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { assertApiKeyWorkspacePathPrincipalCaptured, withApiKeyWorkspacePathPrincipalOnConnection,
  type ApiKeyWorkspacePathPrincipal } from '../api-keys/document-read-principal';
import { assertWorkspaceOperationBatchClaimOnConnection, readWorkspaceOperationBatchClaimBinding,
  type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchClaimBinding } from '../files/workspace-operation-batch-store';
import { decodeWorkspaceOperationApiKeyAuthorization,
  assertWorkspaceOperationApiKeyAuthorizationCurrent } from '../files/workspace-operation-api-key-authorization';
import type { WorkspaceOperationJobPolicyAccess } from './workspace-operation-job-principal';
import { withWorkspaceOperationJobPolicyLifetime } from './workspace-operation-job-policy-lifetime';

type Purpose = 'move_apply' | 'move_recover' | 'delete_apply' | 'delete_recover';
/** Detached holder of an actual live handle, never stored or an authority DTO. */
export type WorkspaceOperationApiKeyJobPrincipal = Readonly<{
  transport: 'api-key'; kind: 'move' | 'delete'; purpose: Purpose; principal: ApiKeyWorkspacePathPrincipal;
}>;
export type WorkspaceOperationApiKeyJobPolicyAccess = WorkspaceOperationJobPolicyAccess & Readonly<{
  transport: 'api-key'; integrationId: string; currentCredentialId: string;
  entryPoint: 'request' | 'mcp'; actorSessionId: null;
}>;
type Code = 'API_KEY_JOB_PRINCIPAL_REQUIRED' | 'API_KEY_JOB_PRINCIPAL_INVALID' | 'API_KEY_JOB_PRINCIPAL_CHANGED'
  | 'API_KEY_JOB_PRINCIPAL_DETACHED' | 'API_KEY_JOB_PRINCIPAL_REENTRANT';
export class WorkspaceOperationApiKeyJobPrincipalError extends Error {
  readonly status: number;
  constructor(readonly code: Code) {
    super(code); this.name = 'WorkspaceOperationApiKeyJobPrincipalError';
    this.status = code.endsWith('REQUIRED') ? 401 : code.endsWith('INVALID') ? 400 : 409;
  }
}
function fail(code: Code): never { throw new WorkspaceOperationApiKeyJobPrincipalError(code); }
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail('API_KEY_JOB_PRINCIPAL_INVALID');
  return input as Record<string, unknown>;
}
export function captureWorkspaceOperationApiKeyJobPrincipal(input: unknown): WorkspaceOperationApiKeyJobPrincipal {
  const value = fields(input, ['transport', 'kind', 'purpose', 'principal']);
  if (value.transport !== 'api-key' || value.kind !== 'move' && value.kind !== 'delete'
    || typeof value.purpose !== 'string' || !['move_apply', 'move_recover', 'delete_apply', 'delete_recover'].includes(value.purpose)
    || !value.purpose.startsWith(`${value.kind}_`)) fail('API_KEY_JOB_PRINCIPAL_INVALID');
  if (!value.principal || typeof value.principal !== 'object' || types.isProxy(value.principal)) fail('API_KEY_JOB_PRINCIPAL_REQUIRED');
  return Object.freeze({ transport: 'api-key', kind: value.kind as 'move' | 'delete', purpose: value.purpose as Purpose,
    principal: value.principal as ApiKeyWorkspacePathPrincipal });
}

/** Synchronous provenance/lifetime preflight, before any pool or filesystem
 * work. Every later B still requires the complete current key/claim policy. */
export function assertWorkspaceOperationApiKeyJobPrincipalCaptured(input: WorkspaceOperationApiKeyJobPrincipal,
  binding: WorkspaceOperationBatchClaimBinding): void {
  const live = captureWorkspaceOperationApiKeyJobPrincipal(input);
  if (binding.authorization.mode !== 'api-key' || binding.actionMode !== 'apply') fail('API_KEY_JOB_PRINCIPAL_REQUIRED');
  const original = decodeWorkspaceOperationApiKeyAuthorization(binding.authorization);
  if (original.kind !== live.kind || original.jobScope.workspaceId !== binding.workspaceId
    || binding.plan.workspaceId !== binding.workspaceId
    || (live.kind === 'move' ? binding.plan.version !== 3 : ![2, 5, 6].includes(binding.plan.version))) fail('API_KEY_JOB_PRINCIPAL_CHANGED');
  assertApiKeyWorkspacePathPrincipalCaptured(live.principal, { workspaceId: binding.workspaceId, purpose: live.purpose });
}

/** Genuine fixed key authority and the actual durable claim share the caller's
 * current B. Original metadata is comparison data; it grants no live access.
 * The caller owns rollback, awaited disposal and confirmed COMMIT. */
export async function withWorkspaceOperationApiKeyJobPolicyOnConnection<T>(database: SqlConnection,
  input: { claim: WorkspaceOperationBatchClaim; principal: WorkspaceOperationApiKeyJobPrincipal },
  operation: (access: WorkspaceOperationApiKeyJobPolicyAccess) => Promise<T>): Promise<T> {
  const selected = fields(input, ['claim', 'principal']), claim = selected.claim as WorkspaceOperationBatchClaim;
  const live = captureWorkspaceOperationApiKeyJobPrincipal(selected.principal), binding = readWorkspaceOperationBatchClaimBinding(claim);
  if (typeof operation !== 'function') fail('API_KEY_JOB_PRINCIPAL_INVALID');
  assertWorkspaceOperationApiKeyJobPrincipalCaptured(live, binding);
  const original = decodeWorkspaceOperationApiKeyAuthorization(binding.authorization);
  let closingFailure: unknown;
  const result = await withApiKeyWorkspacePathPrincipalOnConnection(database, live.principal, live.purpose, async current => {
    let originalVerified = false;
    return withWorkspaceOperationJobPolicyLifetime<WorkspaceOperationApiKeyJobPolicyAccess, T>({
      check: async () => {
        await current.assertCurrent();
        if (await assertWorkspaceOperationBatchClaimOnConnection(database, claim) !== binding) fail('API_KEY_JOB_PRINCIPAL_CHANGED');
        if (!originalVerified) {
          assertWorkspaceOperationApiKeyAuthorizationCurrent(original, { userId: current.userId, integrationId: current.integrationId,
            instanceId: current.instanceId, credentialId: current.credentialId, entryPoint: current.entryPoint,
            workspace: current.workspace, kind: live.kind }, binding.plan);
          originalVerified = true;
        }
        const realm = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
          pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
          (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
          pg_catalog.current_setting('search_path') AS search_path`) as Record<string, unknown> | undefined;
        if (!realm || realm.schema_name !== binding.source.schemaName || Number(realm.schema_oid) !== binding.source.schemaOid
          || Number(realm.database_oid) !== binding.source.databaseOid || realm.search_path !== binding.source.searchPath
          || readWorkspaceOperationBatchClaimBinding(claim) !== binding) fail('API_KEY_JOB_PRINCIPAL_CHANGED');
      },
      assertCoreCurrent: () => current.assertCurrent(),
      error: reason => new WorkspaceOperationApiKeyJobPrincipalError(({
        required: 'API_KEY_JOB_PRINCIPAL_REQUIRED', invalid: 'API_KEY_JOB_PRINCIPAL_INVALID',
        reentrant: 'API_KEY_JOB_PRINCIPAL_REENTRANT', detached: 'API_KEY_JOB_PRINCIPAL_DETACHED',
      } as const)[reason]),
      closingFailure: error => { closingFailure ??= error; },
      access: assertCurrent => Object.freeze({ workspace: current.workspace, userId: current.userId,
        actorType: 'agent', actorId: original.actorId, batchId: binding.batchId, planId: binding.planId, transport: 'api-key',
        integrationId: current.integrationId, currentCredentialId: current.credentialId, entryPoint: current.entryPoint,
        actorSessionId: null, assertCurrent }),
    }, operation);
  });
  if (closingFailure !== undefined) throw closingFailure;
  return result;
}
