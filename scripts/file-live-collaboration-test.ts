import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  createPlainTextYDoc,
  createRichMarkdownYDoc,
  replaceRichMarkdownInYDoc,
  richMarkdownFromYDoc,
} from '../app/lib/collaboration/markdown-state';
import { authoritativeCollaborationSnapshot } from '../app/lib/collaboration/checkpoint';
import { serializeCanonicalText, type PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import {
  getCollaborationRoomConnectionCount,
  reserveCollaborationRoomAdmission,
  withCollaborationRoomLifecycleLock,
} from '../app/lib/collaboration/runtime-state';
import { issueCollaborationTicket, verifyCollaborationTicket } from '../app/lib/collaboration/ticket';

process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'test-only-collaboration-ticket-secret-0001';

const plain = createPlainTextYDoc('one\ntwo\n');
const update = Y.encodeStateAsUpdate(plain);
const plainState: PersistedCollaborationState = {
  documentId: 'plain-document',
  workspaceId: 'workspace-a',
  organizationId: 'org-a',
  path: 'notes.txt',
  representation: 'plain_text',
  lifecycleGeneration: 1,
  schemaVersion: 1,
  yjsState: update,
  stateVector: Y.encodeStateVector(plain),
  documentSequence: 4,
  persistedAt: Date.now(),
  checkpointedAt: null,
  checkpointSequence: 3,
  canonicalHash: null,
  serializedHash: null,
  newlineStyle: 'lf',
  hasBom: false,
  degraded: false,
  status: 'active',
};
assert.deepEqual(authoritativeCollaborationSnapshot(plainState), {
  canonicalContent: 'one\ntwo\n',
  checkpointSequence: 3,
  documentSequence: 4,
  stateVector: Buffer.from(plainState.stateVector).toString('base64'),
});
assert.throws(
  () => authoritativeCollaborationSnapshot({ ...plainState, stateVector: new Uint8Array([0]) }),
  /state and state vector do not match/i,
  'checkpoint materialization must reject a forged or corrupt snapshot identity',
);
const restored = new Y.Doc({ gc: true });
Y.applyUpdate(restored, update);
assert.equal(restored.getText('content').toString(), 'one\ntwo\n');
assert.deepEqual(Y.encodeStateAsUpdate(restored), update, 'binary Yjs state must roundtrip deterministically');

const offline = new Y.Doc({ gc: true });
Y.applyUpdate(offline, update);
offline.getText('content').insert(3, ' offline');
Y.applyUpdate(plain, Y.encodeStateAsUpdate(offline, Y.encodeStateVector(plain)));
assert.equal(plain.getText('content').toString(), 'one offline\ntwo\n');

const markdown = '---\ntitle: Test\n---\n\n# Hello\n\nParagraph with **bold**.\n';
const rich = createRichMarkdownYDoc(markdown);
assert.equal(rich.getXmlFragment('body').length > 0, true);
assert.equal(richMarkdownFromYDoc(rich).trim(), markdown.trim());
const mobileMarkdown = '---\ntitle: Test\n---\n\n# Hello from mobile\n\n- [x] Shared change\n- [ ] Follow up';
replaceRichMarkdownInYDoc(rich, mobileMarkdown, { actorType: 'user', actorId: 'mobile-user' });
assert.equal(
  richMarkdownFromYDoc(rich),
  mobileMarkdown,
  'mobile source replacement must remain lossless inside the authoritative rich Y.Doc',
);

assert.equal(serializeCanonicalText('a\nb\n', { newlineStyle: 'crlf', hasBom: true }), '\uFEFFa\r\nb\r\n');

const issued = issueCollaborationTicket({
  userId: 'user-a', sessionId: 'session-a', workspaceId: 'workspace-a', organizationId: 'org-a',
  documentId: 'doc-a', path: 'notes.md', provider: 'yjs', representation: 'plain_text', permission: 'write', lifecycleGeneration: 1,
}, 10_000);
assert.equal(verifyCollaborationTicket(issued.token, 10_001).documentId, 'doc-a');

plain.destroy();
offline.destroy();
restored.destroy();
rich.destroy();

async function verifyRoomAdmissionRace(): Promise<void> {
  const documentId = 'room-admission-race';
  let allowMigrationCommit!: () => void;
  let reportMigrationCheck!: () => void;
  const migrationCommitAllowed = new Promise<void>((resolve) => {
    allowMigrationCommit = resolve;
  });
  const migrationChecked = new Promise<void>((resolve) => {
    reportMigrationCheck = resolve;
  });
  const migration = withCollaborationRoomLifecycleLock(documentId, async () => {
    assert.equal(getCollaborationRoomConnectionCount(documentId), 0);
    reportMigrationCheck();
    await migrationCommitAllowed;
    assert.equal(
      getCollaborationRoomConnectionCount(documentId),
      0,
      'a room admission must not enter between the empty-room check and lifecycle commit',
    );
  });
  await migrationChecked;
  let admissionEntered = false;
  const admission = withCollaborationRoomLifecycleLock(documentId, async () => {
    admissionEntered = true;
    return reserveCollaborationRoomAdmission(documentId);
  });
  await Promise.resolve();
  assert.equal(admissionEntered, false, 'room admission must wait for the lifecycle transaction');
  allowMigrationCommit();
  await migration;
  const releaseAdmission = await admission;
  assert.equal(getCollaborationRoomConnectionCount(documentId), 1);
  const observedOccupancy = await withCollaborationRoomLifecycleLock(
    documentId,
    async () => getCollaborationRoomConnectionCount(documentId),
  );
  assert.equal(observedOccupancy, 1, 'a pending admission must block an idle-room migration');
  releaseAdmission();
  assert.equal(getCollaborationRoomConnectionCount(documentId), 0);
}

void verifyRoomAdmissionRace().then(
  () => console.log('file-live-collaboration-test: ok'),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
