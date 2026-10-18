import 'server-only';

import { applyPersistedAgentTextOperation, findNativeDocumentEditOperationOriginal,
  type NativeDocumentEditOperationOriginal } from '../collaboration/agent-operations';
import { makeNativeDocumentEditOriginal, nativeDocumentEditBytesProof, nativeDocumentEditDataProof,
  NativeDocumentEditOperationError } from '../collaboration/native-document-edit-operation-contract';
import { prepareNativeDocumentEditSource } from '../collaboration/native-document-edit-source';
import { decodeDocumentEditRequestV1, documentEditRequestFingerprintV1 } from './edit-contracts';
import type { NativeDocumentEditWriteAuthority } from './edit-principal';

/** Internal common edit service. Transport factories retain genuine current
 * authority for its lifetime; returned originals/receipts are data only.
 * Public adapters must select their bounded response, never expose this object.
 * A repeated key is looked up BEFORE inspecting the old search text again. */
export async function applyNativeDocumentEdit(authority: NativeDocumentEditWriteAuthority,
  value: unknown): Promise<NativeDocumentEditOperationOriginal> {
  const request = decodeDocumentEditRequestV1(value);
  const existing = await findNativeDocumentEditOperationOriginal(authority, request);
  if (existing) return existing;

  const source = await prepareNativeDocumentEditSource(authority, request);
  const { prepared } = source;
  const original = makeNativeDocumentEditOriginal({ kind: 'native_document_edit_original', version: 1,
    requestFingerprint: documentEditRequestFingerprintV1(request), identity: prepared.identity,
    expectedVersion: request.expectedVersion, origin: source.origin,
    actor: { userId: source.userId, actorType: source.actorType, actorId: source.actorId, sessionId: source.sessionId },
    source: { path: source.header.identity.path, stateProof: prepared.beforeStateProof,
      stateVectorHash: nativeDocumentEditBytesProof(Buffer.from(source.baseStateVector, 'base64')),
      persistedSequence: source.baseDocumentSequence },
    preparedIntentProof: nativeDocumentEditDataProof({ identity: prepared.identity,
      expectedVersion: request.expectedVersion, targets: prepared.targets }) });
  const operation = await applyPersistedAgentTextOperation({ documentId: request.documentId,
    workspace: source.workspace, initiatedByUserId: source.userId, actorId: source.actorId,
    actorDisplayName: source.actorDisplayName, actorSessionId: source.sessionId,
    idempotencyKey: request.idempotencyKey, runGeneration: 1, targets: prepared.targets,
    requestedMode: 'direct_apply', operationType: 'apply', independentGroups: false,
    agentRunId: source.origin.transport === 'agent-tool' ? source.origin.agentTurnId || undefined : undefined,
    documentPath: source.header.identity.path, documentRepresentation: prepared.identity.representation,
    documentLifecycleGeneration: prepared.identity.lifecycleGeneration, documentSchemaVersion: prepared.identity.schemaVersion,
    baseStateVector: source.baseStateVector, baseDocumentSequence: source.baseDocumentSequence,
    nativeEdit: { original, authority } });
  try {
    // This may confirm stored durability but never replays native targets.
    // Fetch the actual room After; the private preparation preview is not it.
    const result = await findNativeDocumentEditOperationOriginal(authority, request);
    if (!result || result.operation.operationId !== operation.operationId) {
      throw new NativeDocumentEditOperationError('EDIT_OUTCOME_UNCONFIRMED', operation.operationId);
    }
    return result;
  } catch {
    throw new NativeDocumentEditOperationError('EDIT_OUTCOME_UNCONFIRMED', operation.operationId);
  }
}
