import 'server-only';

import { types } from 'node:util';
import type { SqlConnection } from '../db';
import { WorkspaceOperationBatchError, type WorkspaceOperationBatchClaim,
  type WorkspaceOperationBatchClaimBinding } from '../files/workspace-operation-batch-store';
import { captureWorkspaceOperationMcpJobPrincipal, assertWorkspaceOperationMcpJobPrincipalCaptured,
  withWorkspaceOperationMcpJobPolicyOnConnection, type WorkspaceOperationMcpJobPrincipal,
  type WorkspaceOperationMcpJobPolicyAccess } from './workspace-operation-mcp-job-principal';
import { captureWorkspaceOperationApiKeyJobPrincipal, assertWorkspaceOperationApiKeyJobPrincipalCaptured,
  withWorkspaceOperationApiKeyJobPolicyOnConnection, type WorkspaceOperationApiKeyJobPrincipal,
  type WorkspaceOperationApiKeyJobPolicyAccess } from './workspace-operation-api-key-job-principal';

export type WorkspaceOperationProgrammaticJobPrincipal = WorkspaceOperationMcpJobPrincipal | WorkspaceOperationApiKeyJobPrincipal;
export type WorkspaceOperationProgrammaticJobPolicyAccess = WorkspaceOperationMcpJobPolicyAccess | WorkspaceOperationApiKeyJobPolicyAccess;
export type WorkspaceOperationProgrammaticJobOptions = Readonly<{
  mcpPrincipal?: WorkspaceOperationMcpJobPrincipal;
  apiKeyPrincipal?: WorkspaceOperationApiKeyJobPrincipal;
}>;
function invalid(): never {
  throw new WorkspaceOperationBatchError('BATCH_CLAIM_CHANGED', 409, 'The genuine programmatic job principal is required.');
}
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || types.isProxy(input) || Object.getPrototypeOf(input) !== Object.prototype) invalid();
  return input as Record<string, unknown>;
}
function field(input: Record<string, unknown>, name: string): unknown {
  const value = Object.getOwnPropertyDescriptor(input, name);
  if (!value) return undefined;
  if (!value.enumerable || !Object.hasOwn(value, 'value')) invalid();
  return value.value;
}

/** Data holder selection only. Each branch retains its actual opaque handle;
 * this never creates a Session, PI actor, OAuth grant or key credential. */
export function captureWorkspaceOperationProgrammaticJobPrincipal(input: unknown): WorkspaceOperationProgrammaticJobPrincipal {
  const value = object(input);
  return field(value, 'transport') === 'api-key'
    ? captureWorkspaceOperationApiKeyJobPrincipal(value) : captureWorkspaceOperationMcpJobPrincipal(value);
}

/** Distinct internal entry fields cannot carry another transport's holder.
 * Ordinary Session callers omit both. Other operation fields remain owned and
 * validated by the particular runner; no accessor is read here. */
export function captureWorkspaceOperationProgrammaticJobOptions(input: unknown): WorkspaceOperationProgrammaticJobPrincipal | undefined {
  const value = object(input), mcp = field(value, 'mcpPrincipal'), key = field(value, 'apiKeyPrincipal');
  if (mcp !== undefined && key !== undefined) invalid();
  return key !== undefined ? captureWorkspaceOperationApiKeyJobPrincipal(key)
    : mcp !== undefined ? captureWorkspaceOperationMcpJobPrincipal(mcp) : undefined;
}

/** Route captured data back through its own transport's internal entry field. */
export function workspaceOperationProgrammaticJobOptions(input: WorkspaceOperationProgrammaticJobPrincipal | undefined): WorkspaceOperationProgrammaticJobOptions {
  if (input === undefined) return Object.freeze({});
  const principal = captureWorkspaceOperationProgrammaticJobPrincipal(input);
  return Object.freeze('transport' in principal ? { apiKeyPrincipal: principal } : { mcpPrincipal: principal });
}

export function assertWorkspaceOperationProgrammaticJobPrincipalCaptured(input: WorkspaceOperationProgrammaticJobPrincipal,
  binding: WorkspaceOperationBatchClaimBinding): void {
  const principal = captureWorkspaceOperationProgrammaticJobPrincipal(input);
  if ('transport' in principal) assertWorkspaceOperationApiKeyJobPrincipalCaptured(principal, binding);
  else assertWorkspaceOperationMcpJobPrincipalCaptured(principal, binding);
}

/** The actual transport policy authenticates and checks the claim on the same
 * caller-held B. Dispatch adds no grant or transaction ownership. */
export async function withWorkspaceOperationProgrammaticJobPolicyOnConnection<T>(database: SqlConnection,
  input: { claim: WorkspaceOperationBatchClaim; principal: WorkspaceOperationProgrammaticJobPrincipal },
  operation: (access: WorkspaceOperationProgrammaticJobPolicyAccess) => Promise<T>): Promise<T> {
  const value = object(input);
  if (Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'claim') || !Object.hasOwn(value, 'principal')) invalid();
  const claim = field(value, 'claim') as WorkspaceOperationBatchClaim;
  const principal = captureWorkspaceOperationProgrammaticJobPrincipal(field(value, 'principal'));
  return 'transport' in principal ? withWorkspaceOperationApiKeyJobPolicyOnConnection(database, { claim, principal }, operation)
    : withWorkspaceOperationMcpJobPolicyOnConnection(database, { claim, principal }, operation);
}
