import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import * as Y from 'yjs';
import { createInitialTextCollaborationClientState, reduceTextCollaborationClientState } from '../app/lib/collaboration/client-state';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { observeOpenedDocumentAuth, openedDocumentAuthScope, invalidateOpenedDocumentAuth } from '../app/lib/collaboration/opened-document-registry';

async function main() {
  const filename = path.resolve('app/lib/collaboration/client.ts');
  const load = createRequire(filename);
  const compiled = ts.transpileModule(await fs.readFile(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  // Exercise the production retention decision without adding a public API.
  const tested = {} as { park: (candidate: ReturnType<typeof entry>) => boolean };
  new Function('require', 'module', 'exports', compiled.outputText + '\nexports.park = parkTextEntry;')(
    load, { exports: tested }, tested,
  );
  observeOpenedDocumentAuth({ data: { user: { id: 'retention-user' }, session: { id: 'retention-session' } } });
  const documents: Y.Doc[] = [];
  function entry() {
    const doc = new Y.Doc(); documents.push(doc);
    doc.getText('content').insert(0, 'Unchanged persisted content');
    const state = createInitialTextCollaborationClientState({ permission: 'write', documentSequence: 1, checkpointSequence: 1 });
    let destroyed = false;
    return {
      key: 'workspace\0retention-doc', doc, refs: 0, authScope: openedDocumentAuthScope(),
      session: { representation: 'tiptap_xml', stateProof: collaborationStateProof(doc, Y), degraded: false,
        projectionError: undefined as { permanent: boolean } | undefined, guestAccess: undefined as object | undefined },
      persistence: { synced: true }, lifecycle: new AbortController(), requests: new AbortController(),
      clientState: reduceTextCollaborationClientState(state, { type: 'unsynced_changes', count: 1 }),
      provider: { destroy: () => { destroyed = true; } } as { destroy: () => void } | null,
      get providerDestroyed() { return destroyed; },
    };
  }
  try {
    const unchanged = entry();
    const before = { ...unchanged.clientState };
    assert.equal(tested.park(unchanged), true, 'initial sync counter must not discard an exact persisted session snapshot');
    assert.equal(unchanged.providerDestroyed, true, 'inactive retained text must not retain its transport');
    assert.equal(unchanged.requests.signal.aborted, true);
    assert.equal(unchanged.doc.isDestroyed, false);
    assert.deepEqual(unchanged.clientState, before, 'retention must not manufacture a saved state or mark sync complete');

    const edited = entry(); edited.doc.getText('content').insert(0, 'Unsaved ');
    assert.equal(tested.park(edited), false, 'new local content must use the existing durable recovery path');
    assert.equal(edited.providerDestroyed, false);

    const deleted = entry();
    const vectorBefore = Y.encodeStateVector(deleted.doc);
    deleted.doc.getText('content').delete(0, 1);
    assert.deepEqual(Y.encodeStateVector(deleted.doc), vectorBefore, 'a deletion can preserve the state vector');
    assert.equal(tested.park(deleted), false, 'full proof must detect deletions even with an unchanged state vector');

    const denied = entry(); denied.clientState = reduceTextCollaborationClientState(denied.clientState,
      { type: 'authentication_failed', message: 'Access revoked' });
    assert.equal(tested.park(denied), false);
    const degraded = entry(); degraded.session.degraded = true;
    assert.equal(tested.park(degraded), false);
    const projection = entry(); projection.session.projectionError = { permanent: true };
    assert.equal(tested.park(projection), false);
    const guest = entry(); guest.session.guestAccess = {};
    assert.equal(tested.park(guest), false);
    const unhydrated = entry(); unhydrated.persistence.synced = false;
    assert.equal(tested.park(unhydrated), false);
    const plain = entry(); plain.session.representation = 'plain_text';
    assert.equal(tested.park(plain), false);
    const large = entry(); large.doc.getText('content').insert(0, 'x'.repeat(1024 * 1024));
    large.session.stateProof = collaborationStateProof(large.doc, Y);
    assert.equal(tested.park(large), false, 'the existing per-document byte bound remains enforced');
    const signedOut = entry(); invalidateOpenedDocumentAuth();
    assert.equal(tested.park(signedOut), false, 'old authentication partitions cannot retain new entries');
    console.log('Text retention: initial sync, unchanged proof, edits, deletion proof, authentication, quarantine, storage and size boundaries passed.');
  } finally { for (const doc of documents) doc.destroy(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
