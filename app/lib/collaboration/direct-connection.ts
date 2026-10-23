import 'server-only';

import type * as Y from 'yjs';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { DirectMcpEditAuthority } from '@/app/lib/mcp/server/direct-edit-authority';
import type { NativeDocumentEditWriteAuthority } from '@/app/lib/documents/edit-principal';
import { captureNativeDocumentEditVersion, type NativeDocumentEditVersion } from './native-document-edit-version';
import { DocumentEditError } from '@/app/lib/documents/edit-contracts';
import { types } from 'node:util';
import type { TextCollaborationRepresentation } from './types';

/** Raised when the server can no longer prove an agent operation's authority. */
export class AgentDirectConnectionAuthorizationError extends Error {}

export interface AgentDirectConnectionInput {
  documentId: string;
  documentPath: string;
  documentRepresentation: TextCollaborationRepresentation;
  documentLifecycleGeneration: number;
  documentSchemaVersion: number;
  requiresFileCheckpointIdentity: boolean;
  workspace: WorkspaceContext;
  actorId: string;
  actorDisplayName: string;
  initiatedByUserId: string;
  operationId: string;
  actorType?: 'agent' | 'user';
  actorSessionId?: string;
  /** Ephemeral OAuth authority; never written to operation storage or serialized. */
  mcpAuthority?: DirectMcpEditAuthority;
  mcpPolicyFence?: (workspace: WorkspaceContext) => Promise<void>;
  /** Genuine current write capture; historical operation attribution is separate. */
  nativeEditAuthority?: NativeDocumentEditWriteAuthority;
  /** Native comparison evidence. Never a replacement for nativeEditAuthority. */
  nativeDocumentVersion?: NativeDocumentEditVersion;
  versionSource?: 'automatic_checkpoint' | 'restore' | 'agent_apply';
  versionBaseRevisionId?: string | null;
  versionSourceSessionId?: string | null;
  /** Grouped direct tools capture their exact operation snapshot after persistence. */
  agentTurnId?: string;
}

type DirectConnectionHandler = <T>(
  input: AgentDirectConnectionInput,
  apply: (doc: Y.Doc) => T,
  onApplied?: (result: T) => Promise<void>,
) => Promise<T>;

const globalBridge = globalThis as typeof globalThis & { __canvasCollaborationDirectConnection?: DirectConnectionHandler };

/** Read-only availability check for work that must not mutate paths before a live Yjs writer can connect. */
export function isCollaborationDirectConnectionAvailable(): boolean {
  return typeof globalBridge.__canvasCollaborationDirectConnection === 'function';
}

export function installCollaborationDirectConnection(handler: DirectConnectionHandler): () => void {
  globalBridge.__canvasCollaborationDirectConnection = handler;
  return () => {
    if (globalBridge.__canvasCollaborationDirectConnection === handler) {
      delete globalBridge.__canvasCollaborationDirectConnection;
    }
  };
}

export async function runCollaborationDirectConnection<T>(
  input: AgentDirectConnectionInput,
  apply: (doc: Y.Doc) => T,
  onApplied?: (result: T) => Promise<void>,
): Promise<T> {
  const handler = globalBridge.__canvasCollaborationDirectConnection;
  if (!handler) throw new Error('Collaboration server is unavailable; create a review patch instead.');
  if (types.isProxy(input)) throw new DocumentEditError('INVALID_REQUEST');
  const descriptor = Object.getOwnPropertyDescriptor(input, 'nativeDocumentVersion');
  if (descriptor && !Object.hasOwn(descriptor, 'value')) throw new DocumentEditError('INVALID_REQUEST');
  if (!descriptor || descriptor.value === undefined) {
    if (input.nativeEditAuthority !== undefined) throw new DocumentEditError('INVALID_REQUEST');
    return handler(input, apply, onApplied);
  }
  const nativeDocumentVersion = captureNativeDocumentEditVersion(descriptor.value);
  const identity = nativeDocumentVersion.identity;
  if (!input.nativeEditAuthority || identity.workspaceId !== input.workspace.workspaceId
    || identity.organizationId !== (input.workspace.organizationId ?? null) || identity.documentId !== input.documentId
    || identity.representation !== input.documentRepresentation
    || identity.lifecycleGeneration !== input.documentLifecycleGeneration || identity.schemaVersion !== input.documentSchemaVersion) {
    throw new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
  }
  return handler({ ...input, nativeDocumentVersion }, apply, onApplied);
}
