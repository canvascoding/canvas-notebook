import assert from 'node:assert/strict';
import * as Y from 'yjs';
import type { CurrentFile } from '../app/lib/files/types';
import type { CollaborationSessionResponse } from '../app/lib/collaboration/types';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from '../app/lib/collaboration/checkpoint-errors';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState as reduce,
  type TextCollaborationClientEvent } from '../app/lib/collaboration/client-state';
import { findOpenedLiveDocument, hasCurrentOpenedDocumentSessionAuthorization as authorized,
  hasOpenedDocumentLocationSessionReceipt as historical,
  invalidateOpenedLiveDocument, localOpenedDocumentSession, observeOpenedDocumentAuth, openedDocumentAuthScope,
  openedDocumentRequestRevision, rememberOpenedLiveDocument, validateOpenedLiveDocumentSession as validate,
} from '../app/lib/collaboration/opened-document-registry';

const doc = new Y.Doc(); doc.getText('content').insert(0, 'Persisted location state');
const session: CollaborationSessionResponse = { success: true, documentId: 'location-doc', documentName: 'location-doc',
  provider: 'yjs', representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, richTextSchemaVersion: 3,
  permission: 'write', token: 'synthetic-location-token', expiresAt: new Date(Date.now() + 60_000).toISOString(),
  websocketUrl: '/ws/collaboration', user: { id: 'owner', name: 'Owner', color: '#123456', colorLight: '#abcdef' } };
const file: CurrentFile = { path: 'target.txt', content: '', collaboration: { path: 'target.txt', strategy: 'crdt_text',
  crdtCapable: true, sceneCapable: false, lockRequired: false, requiresRevisionCheck: false, latestRevision: null,
  activeLock: null, document: { id: session.documentId, provider: 'yjs', status: 'active', stateVersion: 1,
    snapshotRevisionId: null } } };
const observe = (id = 'login') => observeOpenedDocumentAuth({ data: { user: { id: 'owner' }, session: { id } } });
try {
  observe();
  assert.equal(authorized('workspace', file.path, session), false);
  assert.equal(historical('workspace', file.path, session), false, 'raw data has no historical HTTP provenance');
  assert.equal(validate('workspace', file.path, session), true);
  assert.equal(authorized('workspace', file.path, session), true);
  assert.equal(historical('workspace', file.path, session), true);
  assert.equal(historical('other-workspace', file.path, session), false);
  assert.equal(historical('workspace', 'old.txt', session), false);
  assert.equal(historical('workspace', file.path, { ...session }), false);
  assert.equal(authorized('other-workspace', file.path, session), false);
  assert.equal(authorized('workspace', 'old.txt', session), false);
  assert.equal(authorized('workspace', file.path, { ...session }), false, 'copied data has no HTTP authorization receipt');
  rememberOpenedLiveDocument({ scope: openedDocumentAuthScope(), workspaceId: 'workspace', path: file.path, file, session,
    stateProof: collaborationStateProof(doc, Y)!, snapshot: Y.encodeStateAsUpdate(doc) });
  const cached = findOpenedLiveDocument('workspace', file.path, session.documentId)!;
  assert(cached);
  assert.equal(authorized('workspace', file.path, localOpenedDocumentSession(cached)), false);
  assert.equal(historical('workspace', file.path, localOpenedDocumentSession(cached)), false);
  const obsoleteRevision = openedDocumentRequestRevision();
  invalidateOpenedLiveDocument('workspace', { documentId: session.documentId });
  assert.equal(authorized('workspace', file.path, session), false);
  assert.equal(historical('workspace', file.path, session), true, 'a retired receipt can only request fresh authorization');
  assert.equal(validate('workspace', file.path, { ...session }, openedDocumentAuthScope(), obsoleteRevision), false);
  const read = { ...session, permission: 'read' as const };
  assert.equal(validate('workspace', file.path, read), true);
  assert.equal(authorized('workspace', file.path, read), true, 'fresh read authorization never implies write permission');
  observe('another-login');
  assert.equal(authorized('workspace', file.path, read), false, 'same user in a new auth epoch cannot reuse old receipts');
  assert.equal(historical('workspace', file.path, read), false, 'historical provenance cannot cross an auth epoch');

  const acknowledgement: Extract<TextCollaborationClientEvent, { type: 'authoritative_snapshot' }> = {
    type: 'authoritative_snapshot', documentSequence: 2, checkpointSequence: 2,
    stateVector: Buffer.from(Y.encodeStateVector(doc)).toString('base64'), stateProof: collaborationStateProof(doc, Y)!,
    matchesCurrentDocument: true, degraded: false, projectionFinalized: true, schemaValidated: true,
  };
  const initial = reduce(reduce(createInitialTextCollaborationClientState(), { type: 'indexeddb_hydrated' }),
    { type: 'remote_synced', permission: 'write' });
  const healthy = reduce(initial, acknowledgement);
  const denied = reduce(healthy, { type: 'authentication_failed', message: 'Old path rejected' });
  assert.equal(reduce(denied, { ...acknowledgement, authorizationRevalidated: true }).connection, 'denied');
  const rejoined = reduce({ ...denied, connection: 'reconnecting' }, { type: 'remote_synced', permission: 'write' });
  assert.equal(rejoined.failure?.kind, 'authentication', 'successful sync preserves the reason for the pause');
  assert.equal(reduce(rejoined, acknowledgement).durability, 'degraded');
  assert.equal(reduce(rejoined, { ...acknowledgement, authorizationRevalidated: true }).durability, 'checkpointed_file');
  assert.equal(reduce(rejoined, { ...acknowledgement, matchesCurrentDocument: false, authorizationRevalidated: true }).durability, 'degraded');
  const readRejoined = reduce({ ...denied, connection: 'read_only' }, { type: 'remote_synced', permission: 'read' });
  assert.equal(reduce(readRejoined, { ...acknowledgement, authorizationRevalidated: true }).connection, 'read_only');
  for (const code of [undefined, COLLABORATION_CHECKPOINT_ERROR_CODES.schemaInvalid]) {
    const quarantined = reduce(healthy, { type: 'degraded', message: 'Earlier structure failure', code });
    const revoked = reduce(quarantined, { type: 'authentication_failed', message: 'Then path rejected' });
    const joined = reduce({ ...revoked, connection: 'reconnecting' }, { type: 'remote_synced', permission: 'write' });
    assert.equal(joined.authorizationRecoveryEligible, false);
    assert.equal(reduce(joined, { ...acknowledgement, authorizationRevalidated: true }).durability, 'degraded');
  }
  const subsequentlyQuarantined = reduce(rejoined, { type: 'degraded', message: 'New structure failure' });
  assert.equal(reduce(subsequentlyQuarantined, { ...acknowledgement, authorizationRevalidated: true }).durability, 'degraded');
  console.log('Location authorization: current HTTP receipts, local/revocation/epoch isolation and narrow same-sequence recovery passed.');
} finally { observeOpenedDocumentAuth(null); doc.destroy(); }
