import 'server-only';

import { randomUUID } from 'node:crypto';
import { openDb } from '../db';
import { DocumentEditError, decodeDocumentEditRequestV1 } from '../documents/edit-contracts';
import { withNativeDocumentEditWriteAuthorityOnConnection,
  type NativeDocumentEditWriteAuthority } from '../documents/edit-principal';
import { readCurrentCollaborationDocument } from './document-access';
import { executeLifecycleTransaction } from './lifecycle-transaction';
import { readNativeDocumentHeaderByIdOnConnection } from './native-document-read';
import { prepareNativeDocumentEditInDocument } from './native-document-edit-preparation';
import { Y } from './server-runtime';

/** Genuine current header capture followed by private target preparation.
 * No database client or principal phase survives the subsequent room wait.
 * Returned facts/preview bytes grant no authority; admission and the actual
 * room writer revalidate independently against the same opaque authority. */
export async function prepareNativeDocumentEditSource(authority: NativeDocumentEditWriteAuthority, value: unknown) {
  const request = decodeDocumentEditRequestV1(value);
  const current = await executeLifecycleTransaction({
    openConnection: openDb,
    execute: database => withNativeDocumentEditWriteAuthorityOnConnection(database, authority, async access => {
      if (access.workspace.workspaceId !== request.workspaceId) throw new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
      const header = await readNativeDocumentHeaderByIdOnConnection(database,
        { workspace: access.workspace, documentId: request.documentId });
      await access.assertCurrent();
      return Object.freeze({ header, workspace: structuredClone(access.workspace), origin: structuredClone(access.origin),
        userId: access.userId, actorType: access.actorType, actorId: access.actorId,
        actorDisplayName: access.actorDisplayName, sessionId: access.sessionId });
    }),
    // Preparation has no mutation or operation receipt to recover. In
    // particular, never silently rerun the complete service after an ACK loss.
    recoverCommitted: async (_value, error) => { throw error; },
  });
  const { identity: header } = current.header;
  const identity = Object.freeze({ workspaceId: header.workspaceId, organizationId: header.organizationId,
    documentId: header.documentId, lineageId: header.lineageId, lifecycleGeneration: header.lifecycleGeneration,
    representation: header.representation, schemaVersion: header.schemaVersion });
  const observed = await readCurrentCollaborationDocument({ documentId: header.documentId, workspaceId: header.workspaceId,
    read: (doc, state) => {
      if (!state || state.status !== 'active' || state.documentId !== header.documentId
        || state.workspaceId !== header.workspaceId || state.organizationId !== header.organizationId
        || state.path !== header.path || state.representation !== header.representation
        || state.lifecycleGeneration !== header.lifecycleGeneration || state.schemaVersion !== header.schemaVersion) {
        throw new DocumentEditError('DOCUMENT_SCOPE_CHANGED');
      }
      if (state.degraded) throw new DocumentEditError('DOCUMENT_STATE_INVALID');
      const prepared = prepareNativeDocumentEditInDocument({ doc, identity, expectedVersion: request.expectedVersion,
        patch: request.patch, groupId: `native-edit:${randomUUID()}` });
      return Object.freeze({ prepared, baseStateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'),
        baseDocumentSequence: state.documentSequence, persistedAt: state.persistedAt });
    } });
  return Object.freeze({ request, ...current, ...observed });
}
