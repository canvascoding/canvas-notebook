import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { assertDirectMcpWorkspaceMovePrincipalCaptured, assertDirectMcpWorkspaceDeletePrincipalCaptured,
  withDirectMcpWorkspaceMovePrincipalOnConnection, withDirectMcpWorkspaceDeletePrincipalOnConnection,
  type DirectMcpWorkspaceMovePrincipal, type DirectMcpWorkspaceDeletePrincipal,
  type DirectMcpWorkspaceMovePrincipalAccess, type DirectMcpWorkspaceDeletePrincipalAccess } from '../mcp/server/document-read-principal';
import { assertWorkspaceOperationBatchClaimOnConnection, readWorkspaceOperationBatchClaimBinding,
  type WorkspaceOperationBatchClaim, type WorkspaceOperationBatchClaimBinding } from '../files/workspace-operation-batch-store';
import { decodeWorkspaceOperationMcpAuthorization,
  assertWorkspaceOperationMcpAuthorizationCurrent } from '../files/workspace-operation-mcp-authorization';
import type { WorkspaceOperationJobPolicyAccess } from './workspace-operation-job-principal';

/** A detached immutable holder of a genuine live handle. It is never stored. */
export type WorkspaceOperationMcpJobPrincipal = Readonly<{ kind: 'move'; principal: DirectMcpWorkspaceMovePrincipal }>
  | Readonly<{ kind: 'delete'; principal: DirectMcpWorkspaceDeletePrincipal }>;
export type WorkspaceOperationMcpJobPolicyAccess = WorkspaceOperationJobPolicyAccess & Readonly<{
  transport: 'direct-mcp'; clientId: string; currentSessionId: string;
}>;
export class WorkspaceOperationMcpJobPrincipalError extends Error {
  readonly status: number;
  constructor(readonly code: 'MCP_JOB_PRINCIPAL_REQUIRED' | 'MCP_JOB_PRINCIPAL_INVALID'
    | 'MCP_JOB_PRINCIPAL_CHANGED' | 'MCP_JOB_PRINCIPAL_DETACHED' | 'MCP_JOB_PRINCIPAL_REENTRANT') {
    super(code); this.name = 'WorkspaceOperationMcpJobPrincipalError';
    this.status = code.endsWith('REQUIRED') ? 401 : code.endsWith('INVALID') ? 400 : 409;
  }
}
function fail(code: WorkspaceOperationMcpJobPrincipalError['code']): never {
  throw new WorkspaceOperationMcpJobPrincipalError(code);
}
function fields(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Reflect.ownKeys(input).length !== keys.length || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) fail('MCP_JOB_PRINCIPAL_INVALID');
  return input as Record<string, unknown>;
}
export function captureWorkspaceOperationMcpJobPrincipal(input: unknown): WorkspaceOperationMcpJobPrincipal {
  const value = fields(input, ['kind', 'principal']);
  if (!value.principal || typeof value.principal !== 'object' || types.isProxy(value.principal)) fail('MCP_JOB_PRINCIPAL_REQUIRED');
  if (value.kind === 'move') return Object.freeze({ kind: 'move', principal: value.principal as DirectMcpWorkspaceMovePrincipal });
  if (value.kind === 'delete') return Object.freeze({ kind: 'delete', principal: value.principal as DirectMcpWorkspaceDeletePrincipal });
  return fail('MCP_JOB_PRINCIPAL_INVALID');
}

/** Synchronous provenance/lifetime preflight only, before any pool/FS access.
 * Every later B still requires the complete actual current policy below. */
export function assertWorkspaceOperationMcpJobPrincipalCaptured(input: WorkspaceOperationMcpJobPrincipal,
  binding: WorkspaceOperationBatchClaimBinding): void {
  const live = captureWorkspaceOperationMcpJobPrincipal(input);
  if (binding.authorization.mode !== 'direct-mcp' || binding.actionMode !== 'apply') fail('MCP_JOB_PRINCIPAL_REQUIRED');
  const original = decodeWorkspaceOperationMcpAuthorization(binding.authorization);
  if (original.jobScope.workspaceId !== binding.workspaceId || binding.plan.workspaceId !== binding.workspaceId
    || original.tool !== (live.kind === 'move' ? 'move_knowledge_source' : 'delete_knowledge_source')
    || (live.kind === 'move' ? binding.plan.version !== 3 : binding.plan.version !== 2 && binding.plan.version !== 5 && binding.plan.version !== 6)) fail('MCP_JOB_PRINCIPAL_CHANGED');
  const options = { workspaceId: binding.workspaceId };
  if (live.kind === 'move') assertDirectMcpWorkspaceMovePrincipalCaptured(live.principal, options);
  else assertDirectMcpWorkspaceDeletePrincipalCaptured(live.principal, options);
}

/** Fixed actual claim + current OAuth authority on the same caller-held B.
 * No member/PI principal, transaction owner or historical session is minted.
 * The caller owns rollback, awaited disposal and confirmed COMMIT. */
export async function withWorkspaceOperationMcpJobPolicyOnConnection<T>(database: SqlConnection,
  input: { claim: WorkspaceOperationBatchClaim; principal: WorkspaceOperationMcpJobPrincipal },
  operation: (access: WorkspaceOperationMcpJobPolicyAccess) => Promise<T>): Promise<T> {
  const selected = fields(input, ['claim', 'principal']), claim = selected.claim as WorkspaceOperationBatchClaim;
  const live = captureWorkspaceOperationMcpJobPrincipal(selected.principal);
  const binding = readWorkspaceOperationBatchClaimBinding(claim);
  if (typeof operation !== 'function') fail('MCP_JOB_PRINCIPAL_INVALID');
  assertWorkspaceOperationMcpJobPrincipalCaptured(live, binding);
  const original = decodeWorkspaceOperationMcpAuthorization(binding.authorization);
  let closingFailure: unknown;
  const execute = async (current: DirectMcpWorkspaceMovePrincipalAccess | DirectMcpWorkspaceDeletePrincipalAccess): Promise<T> => {
    let active = true, accepting = true, checking = false, originalVerified = false, failure: unknown;
    const pending = new Set<Promise<void>>();
    const check = async (): Promise<void> => {
      try {
        if (!active) fail('MCP_JOB_PRINCIPAL_REQUIRED');
        if (failure !== undefined) throw failure;
        if (checking) fail('MCP_JOB_PRINCIPAL_REENTRANT');
        checking = true;
        try {
          await current.assertCurrent();
          if (await assertWorkspaceOperationBatchClaimOnConnection(database, claim) !== binding) fail('MCP_JOB_PRINCIPAL_CHANGED');
          // The actual claim pins frozen plan/auth bytes and every later SQL
          // check compares those original bytes again. Verify the complete
          // plan hash once per B; the fixed MCP capture pins current identity
          // and namespace while assertCurrent rechecks live rights each time.
          if (!originalVerified) {
            assertWorkspaceOperationMcpAuthorizationCurrent(original, { userId: current.userId,
              clientId: current.clientId, sessionId: current.sessionId, workspace: current.workspace, tool: current.tool }, binding.plan);
            originalVerified = true;
          }
          const realm = await database.get(`SELECT pg_catalog.current_schema() AS schema_name,
            pg_catalog.to_regnamespace(pg_catalog.current_schema())::oid::bigint AS schema_oid,
            (SELECT oid::bigint FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS database_oid,
            pg_catalog.current_setting('search_path') AS search_path`) as Record<string, unknown> | undefined;
          if (!realm || realm.schema_name !== binding.source.schemaName || Number(realm.schema_oid) !== binding.source.schemaOid
            || Number(realm.database_oid) !== binding.source.databaseOid || realm.search_path !== binding.source.searchPath) {
            fail('MCP_JOB_PRINCIPAL_CHANGED');
          }
          if (readWorkspaceOperationBatchClaimBinding(claim) !== binding) fail('MCP_JOB_PRINCIPAL_CHANGED');
        } finally { checking = false; }
      } catch (error) { failure ??= error ?? new WorkspaceOperationMcpJobPrincipalError('MCP_JOB_PRINCIPAL_INVALID'); throw failure; }
    };
    const assertCurrent = (): Promise<void> => {
      const promise = (async () => {
        try {
          if (!accepting) {
            // Preserve the real Core phase's poison/drain contract even while
            // its final policy check is still completing after our callback.
            await current.assertCurrent();
            fail('MCP_JOB_PRINCIPAL_REQUIRED');
          }
          await check();
        } catch (error) {
          failure ??= error ?? new WorkspaceOperationMcpJobPrincipalError('MCP_JOB_PRINCIPAL_INVALID');
          closingFailure ??= failure;
          throw failure;
        }
      })();
      pending.add(promise);
      void promise.finally(() => pending.delete(promise)).catch(() => undefined);
      return promise;
    };
    try {
      await check();
      const result = await operation(Object.freeze({ workspace: current.workspace, userId: current.userId,
        actorType: 'agent', actorId: original.actorId, batchId: binding.batchId, planId: binding.planId,
        transport: 'direct-mcp', clientId: current.clientId, currentSessionId: current.sessionId, assertCurrent }));
      accepting = false;
      if (pending.size) {
        failure ??= new WorkspaceOperationMcpJobPrincipalError('MCP_JOB_PRINCIPAL_DETACHED');
        await Promise.allSettled([...pending]);
      }
      if (failure !== undefined) throw failure;
      await check();
      if (failure !== undefined) throw failure;
      return result;
    } finally {
      accepting = false;
      if (pending.size) await Promise.allSettled([...pending]);
      active = false;
    }
  };
  const result = live.kind === 'move' ? await withDirectMcpWorkspaceMovePrincipalOnConnection(database, live.principal, execute)
    : await withDirectMcpWorkspaceDeletePrincipalOnConnection(database, live.principal, execute);
  if (closingFailure !== undefined) throw closingFailure;
  return result;
}
