import assert from 'node:assert/strict';
import {
  getWorkspacePresenceSnapshot,
  removeDocumentPresenceEntry,
  replaceDocumentPresence,
  upsertDocumentPresenceEntry,
} from '../app/lib/collaboration/presence';

const base = {
  workspaceId: 'workspace-presence', documentId: 'doc-a', path: 'notes.md', userId: 'user-a', sessionId: 'tab-a',
  actorType: 'user' as const, initiatedByUserId: null, displayName: 'Alice', color: '#2563eb', colorLight: '#dbeafe',
  activity: 'editing' as const, updatedAt: Date.now(),
};
replaceDocumentPresence(base.workspaceId, base.documentId, [base, { ...base, sessionId: 'tab-b', updatedAt: base.updatedAt + 1 }]);
let snapshot = getWorkspacePresenceSnapshot(base.workspaceId);
assert.equal(snapshot.entries.length, 1, 'multiple tabs for one user are deduplicated');
assert.equal(snapshot.entries[0].sessionId, 'tab-b');

upsertDocumentPresenceEntry({
  ...base, userId: 'agent-a', sessionId: 'operation-a', actorType: 'agent', initiatedByUserId: 'user-b',
  displayName: 'Research Agent', activity: 'agent_editing', color: '#7c3aed', colorLight: '#ede9fe', updatedAt: Date.now(),
});
snapshot = getWorkspacePresenceSnapshot(base.workspaceId);
assert.deepEqual(new Set(snapshot.entries.map((entry) => entry.activity)), new Set(['editing', 'agent_editing']));
removeDocumentPresenceEntry({ workspaceId: base.workspaceId, documentId: base.documentId, userId: 'agent-a', actorType: 'agent' });
assert.equal(getWorkspacePresenceSnapshot(base.workspaceId).entries.length, 1);
replaceDocumentPresence(base.workspaceId, base.documentId, []);
assert.equal(getWorkspacePresenceSnapshot(base.workspaceId).entries.length, 0);
console.log('file-presence-policy-test: ok');
