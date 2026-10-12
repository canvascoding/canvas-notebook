import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import {
  CollaborationAdmissionError,
  captureCollaborationAdmissionWriterScope,
} from './room-admission-contract';
import type { CollaborationRoomOwnerScope } from './room-owner';

export type WorkspaceFileLifecycleLease = { active: boolean; verify: () => Promise<boolean> };
type CollaborationWriteGrant = {
  active: boolean;
  lease: WorkspaceFileLifecycleLease;
  scope: CollaborationRoomOwnerScope;
};

// Keep the existing global key: the Next.js bundles and the custom server must
// observe the same lease, including its invalidation after the owning callback.
const shared = globalThis as typeof globalThis & {
  __canvasWorkspaceFileLifecycleGuardV1?: AsyncLocalStorage<ReadonlyMap<string, WorkspaceFileLifecycleLease>>;
  __canvasWorkspaceFileLifecycleCollaborationWriteV1?: AsyncLocalStorage<CollaborationWriteGrant>;
};
const lifecycleContext = shared.__canvasWorkspaceFileLifecycleGuardV1 ??=
  new AsyncLocalStorage<ReadonlyMap<string, WorkspaceFileLifecycleLease>>();
const collaborationWriteContext = shared.__canvasWorkspaceFileLifecycleCollaborationWriteV1 ??=
  new AsyncLocalStorage<CollaborationWriteGrant>();

export function getWorkspaceFileLifecycleLeases(): ReadonlyMap<string, WorkspaceFileLifecycleLease> | undefined {
  return lifecycleContext.getStore();
}

/** The lifecycle guard publishes its actual dedicated-session lease here. */
export function withWorkspaceFileLifecycleLeases<T>(leases: ReadonlyMap<string, WorkspaceFileLifecycleLease>,
  operation: () => Promise<T>): Promise<T> {
  return lifecycleContext.run(new Map(leases), operation);
}

function captureWriteScope(input: CollaborationRoomOwnerScope): CollaborationRoomOwnerScope {
  const identity = captureCollaborationAdmissionWriterScope(input);
  if ((input.organizationId !== null && (typeof input.organizationId !== 'string' || !input.organizationId))
    || !['plain_text', 'tiptap_xml', 'tiptap_blocks'].includes(input.representation)
    || !Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1
    || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throw new CollaborationAdmissionError('ADMISSION_INVALID_REQUEST');
  }
  return Object.freeze({ ...identity, organizationId: input.organizationId, representation: input.representation,
    lifecycleGeneration: input.lifecycleGeneration, schemaVersion: input.schemaVersion });
}

/**
 * Reuses a file operation's admission key only for this exact, server-validated
 * collaborative writer. This is not ACL, room ownership, or mutation authority.
 */
export async function withWorkspaceFileLifecycleCollaborationWrite<T>(input: CollaborationRoomOwnerScope,
  operation: () => Promise<T>): Promise<T> {
  const lease = lifecycleContext.getStore()?.get(input.workspaceId);
  if (!lease) return operation();
  const scope = captureWriteScope(input);
  if (!lease.active || !await lease.verify() || !lease.active
    || lifecycleContext.getStore()?.get(scope.workspaceId) !== lease) {
    throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
  }
  const grant: CollaborationWriteGrant = { active: true, lease, scope };
  try { return await collaborationWriteContext.run(grant, operation); }
  finally { grant.active = false; }
}

/** A stale callback or lost backend must never authorize an advisory-lock bypass. */
export async function hasVerifiedWorkspaceFileLifecycleCollaborationWrite(input: CollaborationRoomOwnerScope): Promise<boolean> {
  const grant = collaborationWriteContext.getStore();
  if (!grant) return false;
  if (!grant.active || !grant.lease.active
    || lifecycleContext.getStore()?.get(grant.scope.workspaceId) !== grant.lease) {
    throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
  }
  const scope = captureWriteScope(input);
  if (Object.keys(grant.scope).some(key => grant.scope[key as keyof CollaborationRoomOwnerScope]
    !== scope[key as keyof CollaborationRoomOwnerScope])) return false;
  if (!await grant.lease.verify() || !grant.active || !grant.lease.active
    || collaborationWriteContext.getStore() !== grant
    || lifecycleContext.getStore()?.get(grant.scope.workspaceId) !== grant.lease) {
    throw new CollaborationAdmissionError('ADMISSION_CONFLICT');
  }
  return true;
}
