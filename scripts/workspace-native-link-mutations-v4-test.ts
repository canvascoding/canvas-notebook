import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks, inspectPersistedDocumentLinksV4, nativeLinkJsonProof }
  from '../app/lib/markdown/workspace-native-link-inventory';
import { assertPreparedNativeLinkInspectionProfile, NativeLinkMutationConflict, prepareNativeLinkInverseV4,
  prepareNativeLinkMutations, prepareNativeLinkMutationsV4, verifyPreparedNativeLinkMutationV4,
  type AnyPreparedNativeLinkUpdate, type PreparedNativeLinkUpdateV4 }
  from '../app/lib/markdown/workspace-native-link-mutations';
import { captureNativeFileOperationBundle, decodeNativeFileOperationBundleText,
  type NativeFileOperationBundle } from '../app/lib/markdown/native-file-operation-handoff';
import { nativeLinkPreparedIntentProof } from '../app/lib/markdown/native-link-mutation-persistence';
import type { NativeLinkMutationRecipe } from '../app/lib/markdown/workspace-link-contract-v2';

function stateFor(doc: InstanceType<typeof Y.Doc>, representation: PersistedCollaborationState['representation'] = 'plain_text'):
  PersistedCollaborationState {
  return { documentId: 'native-mutation-v4', workspaceId: 'workspace', organizationId: null, path: 'source.md', representation,
    lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 7, checkpointSequence: 0, persistedAt: 100, checkpointedAt: null, canonicalHash: null,
    serializedHash: null, newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active' };
}
function recipesFor(state: PersistedCollaborationState, literal = 'target.md', nextValue = 'renamed-long.md'):
  NativeLinkMutationRecipe[] {
  const inventory = inspectPersistedDocumentLinksV4(state);
  return inventory.links.filter(link => link.literal === literal).map(link => ({ linkId: link.id, source: inventory.document,
    destinationWorkspaceId: state.workspaceId, sourcePathAfter: state.path, cloneSelection: null, sourceVersion: inventory.version,
    reference: link.ref, action: 'rewrite', nextValue, expectedTargetIdentity: 'document:target:1' }));
}
function bundleFor(state: PersistedCollaborationState, prepared: AnyPreparedNativeLinkUpdate): NativeFileOperationBundle {
  return { version: 1, operationId: 'move', requestId: 'c0dcde0e-1cc9-4f34-9c5f-e6410aff67dc', action: 'move',
    actor: { actorUserId: 'owner', actorId: 'actor', actorType: 'user', actorSessionId: null }, reviewDigest: 'a'.repeat(64),
    mutations: [{ mutationId: prepared.operationId, kind: 'link', source: prepared.source, lineageId: 'lineage', registryStateVersion: 6,
      before: { ...prepared.before, persistedAt: state.persistedAt, binaryHash: createHash('sha256').update(state.yjsState).digest('hex') },
      destinationPath: null, trashEntryId: null, prepared }] };
}
const reject = (action: () => unknown, code?: NativeLinkMutationConflict['code']) => assert.throws(action,
  error => error instanceof NativeLinkMutationConflict && (code === undefined || error.code === code));

/** Real Yjs binaries, relative anchors and HTML parsing. Bundle serialization is
 * a private DTO check; this suite proves no SQL/FD/ACL or owner authority. */
export function workspaceNativeLinkMutationsV4Test(): void {
  let groups = 0;
  // Include actual top-level HTML for the historical parser2 coverage guard;
  // the nested Markdown-label HTML is intentionally first inspected by4.
  const source = '\uFEFF---\r\ntitle: Source\r\n---\r\n😀 [<img src="stable.png">Target](target.md)\r\n\r\n[[Wiki|<b>Alias</b>]]\r\n\r\n<img src="separate.png">\r\n';
  const doc = createPlainTextYDoc(source);
  try {
    const before = stateFor(doc); const originalBytes = Buffer.from(before.yjsState);
    const recipes = recipesFor(before); assert.equal(recipes.length, 1);
    const prepared = prepareNativeLinkMutationsV4({ state: before, recipes, operationId: 'forward' });
    assert.equal(prepared.contractVersion, 4); assert.equal(prepared.parserVersion, 4);
    assert.match(prepared.htmlSourceProof, /^[a-f0-9]{64}$/u);
    assert.deepEqual(Buffer.from(before.yjsState), originalBytes);
    assert.equal(doc.getText('content').toString(), source);
    Y.applyUpdate(doc, prepared.update);
    assert.equal(doc.getText('content').toString(), source.replace('](target.md)', '](renamed-long.md)'));
    const after = stateFor(doc);
    verifyPreparedNativeLinkMutationV4({ before, after, prepared });
    assert.equal(inspectPersistedDocumentLinksV4(after).coverage.complete, false);
    assert.equal('documentSequence' in prepared.after, false);
    groups++;

    const inverse = prepareNativeLinkInverseV4({ state: after, inverseRecipes: prepared.inverseRecipes, operationId: 'inverse' });
    assert.equal(inverse.contractVersion, 4); assert.equal(inverse.htmlSourceProof, prepared.htmlSourceProof);
    Y.applyUpdate(doc, inverse.update); assert.equal(doc.getText('content').toString(), source);
    groups++;

    // The old profile retains its strict coverage rule and does not adopt a new
    // parser simply because its caller presents parser-4 recipes.
    reject(() => prepareNativeLinkMutations({ state: before, recipes, operationId: 'old' }), 'incomplete-coverage');
    groups++;

    for (const changed of [
      { ...before, documentSequence: 8 }, { ...before, path: 'foreign.md' }, { ...before, lifecycleGeneration: 2 },
    ]) reject(() => prepareNativeLinkMutationsV4({ state: changed, recipes, operationId: 'stale' }), 'source-changed');
    reject(() => prepareNativeLinkMutationsV4({ state: before, recipes: [...recipes, ...recipes], operationId: 'duplicate' }), 'target-changed');
    reject(() => prepareNativeLinkMutationsV4({ state: before, recipes: [{ ...recipes[0], cloneSelection: 'clone' }], operationId: 'clone' }), 'source-changed');
    groups++;

    // Even a forged after-state proof cannot authorize changing the HTML. Its
    // ordered actual syntax proof must still match both inspected binaries.
    Y.applyUpdate(doc, prepared.update);
    const text = doc.getText('content'); const index = text.toString().indexOf('stable.png');
    text.delete(index, 'stable.png'.length); text.insert(index, 'other.png');
    const changed = stateFor(doc); const actual = inspectPersistedDocumentLinksV4(changed);
    reject(() => verifyPreparedNativeLinkMutationV4({ before, after: changed, prepared: { ...prepared,
      after: { stateProof: actual.version.stateProof, stateVector: actual.version.stateVector } } }), 'target-changed');
    reject(() => verifyPreparedNativeLinkMutationV4({ before, after, prepared: { ...prepared, htmlSourceProof: '0'.repeat(64) } }), 'target-changed');
    groups++;

    for (const malformed of [
      { ...prepared, parserVersion: 2 }, { ...prepared, contractVersion: 2 }, { ...prepared, htmlSourceProof: 'bad' },
      { ...prepared, inspectionProfile: 'ignore-coverage' },
    ]) {
      reject(() => assertPreparedNativeLinkInspectionProfile(malformed as PreparedNativeLinkUpdateV4), 'invalid-recipe');
      assert.throws(() => captureNativeFileOperationBundle(bundleFor(before, malformed as PreparedNativeLinkUpdateV4)),
        error => (error as { code?: unknown }).code === 'NATIVE_FILE_INVALID_INTENT');
    }
    const captured = captureNativeFileOperationBundle(bundleFor(before, prepared));
    assert.equal(decodeNativeFileOperationBundleText(captured.privateText).privateText, captured.privateText);
    assert.equal(decodeNativeFileOperationBundleText(captured.privateText).bundle.mutations[0].prepared?.contractVersion, 4);
    groups++;

    assert.notEqual(nativeLinkPreparedIntentProof(prepared), nativeLinkPreparedIntentProof({ ...prepared, htmlSourceProof: '0'.repeat(64) }));
    const ordinary = createPlainTextYDoc('[Target](target.md)');
    try {
      const state = stateFor(ordinary); const inventory = inspectPersistedDocumentLinks(state);
      const old = prepareNativeLinkMutations({ state, recipes: recipesFor(state).map(recipe => ({ ...recipe,
        linkId: inventory.links[0].id, reference: inventory.links[0].ref, sourceVersion: inventory.version })), operationId: 'legacy' });
      assert.equal(nativeLinkPreparedIntentProof(old), nativeLinkJsonProof({ contractVersion: old.contractVersion, operationId: old.operationId,
        source: old.source, before: old.before, after: old.after,
        updateHash: createHash('sha256').update(old.update).digest('hex'), inverseRecipes: old.inverseRecipes }));
      assert.equal(Object.hasOwn(old, 'parserVersion'), false); assert.equal(Object.hasOwn(old, 'htmlSourceProof'), false);
    } finally { ordinary.destroy(); }
    groups++;
  } finally { doc.destroy(); }

  // Opaque HTML is rejected even if it contains no apparent local URL, or is
  // nested inside a Markdown label the ordinary grammar used to skip.
  for (const html of ['<custom-element></custom-element>', '<script>noop()</script>',
    '[<custom-element resource="asset.png">Label</custom-element>](target.md)', '<img srcset="a.png 1x, b.png 2x">']) {
    const value = createPlainTextYDoc(`[Target](target.md)\n\n${html}`);
    try {
      const state = stateFor(value); const bytes = Buffer.from(state.yjsState);
      reject(() => prepareNativeLinkMutationsV4({ state, recipes: recipesFor(state), operationId: 'opaque' }), 'incomplete-coverage');
      assert.deepEqual(Buffer.from(stateFor(value).yjsState), bytes);
    } finally { value.destroy(); }
  }
  groups++;

  const unknown = createPlainTextYDoc('[Target](target.md)\n\n<div>Static</div>');
  try {
    unknown.getMap('unexpected-root').set('value', true); const state = stateFor(unknown);
    reject(() => prepareNativeLinkMutationsV4({ state, recipes: recipesFor(state), operationId: 'unknown' }), 'incomplete-coverage');
  } finally { unknown.destroy(); }
  groups++;

  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const value = createRichMarkdownYDoc('[Target](target.md)\n\n[[Wiki|Alias]]\n\nIndependent', representation);
    try {
      const state = stateFor(value, representation); const original = inspectPersistedDocumentLinksV4(state);
      const forward = prepareNativeLinkMutationsV4({ state, recipes: recipesFor(state), operationId: 'rich-forward' });
      Y.applyUpdate(value, forward.update);
      const after = stateFor(value, representation);
      verifyPreparedNativeLinkMutationV4({ before: state, after, prepared: forward });
      assert.deepEqual(inspectPersistedDocumentLinksV4(after).links.map(link => link.id), original.links.map(link => link.id));
      const inverse = prepareNativeLinkInverseV4({ state: after, inverseRecipes: forward.inverseRecipes, operationId: 'rich-inverse' });
      Y.applyUpdate(value, inverse.update);
      assert.deepEqual(inspectPersistedDocumentLinksV4(stateFor(value, representation)).links.map(link => link.literal), original.links.map(link => link.literal));
    } finally { value.destroy(); }
  }
  groups++;

  const later = createPlainTextYDoc('[Target](target.md)\n\n<img src="stable.png">\n\nIndependent');
  try {
    const state = stateFor(later); const forward = prepareNativeLinkMutationsV4({ state, recipes: recipesFor(state), operationId: 'later-forward' });
    Y.applyUpdate(later, forward.update); const text = later.getText('content'); text.insert(text.length, ' changed later');
    const inverse = prepareNativeLinkInverseV4({ state: stateFor(later), inverseRecipes: forward.inverseRecipes, operationId: 'later-inverse' });
    Y.applyUpdate(later, inverse.update);
    assert.equal(text.toString(), '[Target](target.md)\n\n<img src="stable.png">\n\nIndependent changed later');
  } finally { later.destroy(); }
  groups++;
  assert.equal(groups, 11);
  console.log(JSON.stringify({ suite: 'native-link-mutations-v4', groups, actualYjs: true, executionAuthority: false }));
}
