import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { CollaborationBlockTree } from '../app/lib/collaboration/block-tree';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { createPlainTextYDoc, createRichMarkdownYDoc, richMarkdownSchemaExtensions, validateRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import { inspectPersistedDocumentLinks } from '../app/lib/markdown/workspace-native-link-inventory';
import { NativeLinkMutationConflict, prepareNativeLinkInverse, prepareNativeLinkMutations } from '../app/lib/markdown/workspace-native-link-mutations';
import type { NativeLinkMutationRecipe } from '../app/lib/markdown/workspace-link-contract-v2';

function stateFor(doc: Y.Doc, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): PersistedCollaborationState {
  return { documentId: 'document', workspaceId: 'workspace', organizationId: null, path: 'note.md', representation,
    lifecycleGeneration: 1, schemaVersion: 1, yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc),
    documentSequence: 7, checkpointSequence: 0, persistedAt: 100, checkpointedAt: null, canonicalHash: null,
    serializedHash: null, newlineStyle: 'lf', hasBom: false, degraded: false, status: 'active' };
}

function recipes(state: PersistedCollaborationState, action: 'rewrite' | 'unlink', nextValue = 'renamed.md'): NativeLinkMutationRecipe[] {
  const inventory = inspectPersistedDocumentLinks(state);
  return inventory.links.filter((link) => link.classification === 'local').map((link) => ({ linkId: link.id, source: inventory.document,
    destinationWorkspaceId: state.workspaceId, sourcePathAfter: state.path, cloneSelection: null, sourceVersion: inventory.version,
    reference: link.ref, action, nextValue: action === 'unlink' ? null : nextValue, expectedTargetIdentity: 'document:target:1' }));
}

function paragraphText(doc: Y.Doc, last = false): Y.XmlText {
  const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
  const paragraphs = [...tree.records.entries()].filter(([, record]) => (record.get('shape') as { type: string }).type === 'paragraph');
  return tree.content(paragraphs[last ? paragraphs.length - 1 : 0][0]).toArray().find((child) => child instanceof Y.XmlText) as Y.XmlText;
}

function hrefs(doc: Y.Doc, representation: PersistedCollaborationState['representation'] = 'tiptap_blocks'): string[] {
  return inspectPersistedDocumentLinks(stateFor(doc, representation)).links.map((link) => link.literal);
}

test('target-only native changes work through an export failure and Undo preserves another edited paragraph', () => {
  const doc = createRichMarkdownYDoc('| Keep |\n| --- |\n| [Target](target.md) |\n\nIndependent', 'tiptap_blocks');
  try {
    const tree = new CollaborationBlockTree(doc, getSchema(richMarkdownSchemaExtensions()));
    for (const record of tree.records.values()) if (['tableCell', 'tableHeader'].includes((record.get('shape') as { type: string }).type)) {
      (record.get('attributes') as Y.Map<unknown>).set('colwidth', [120]);
    }
    assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const state = stateFor(doc); const before = structuredClone(state);
    const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'rewrite'), operationId: 'forward' });
    assert.deepEqual(state, before); assert.deepEqual(hrefs(doc), ['target.md']);
    assert.equal('documentSequence' in prepared.after, false);
    Y.applyUpdate(doc, prepared.update);
    assert.deepEqual(hrefs(doc), ['renamed.md']); assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
    const independent = paragraphText(doc, true); independent.insert(independent.length, ' changed later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update);
    assert.deepEqual(hrefs(doc), ['target.md']); assert.equal(independent.toString(), 'Independent changed later');
    const native = authoritativeNativeCollaborationSnapshot(stateFor(doc));
    assert.match(JSON.stringify(native.content), /"colwidth":\[120\]/u);
  } finally { doc.destroy(); }
});

test('Undo refuses a changed href, label, or marks in its scope', () => {
  for (const alteration of ['href', 'label', 'marks'] as const) {
    const doc = createRichMarkdownYDoc('[Target](target.md)\n\nIndependent', 'tiptap_blocks');
    try {
      const state = stateFor(doc); const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'rewrite'), operationId: 'forward' });
      Y.applyUpdate(doc, prepared.update); const text = paragraphText(doc);
      if (alteration === 'href') text.format(0, text.length, { link: { href: 'different.md' } });
      else if (alteration === 'label') text.insert(1, 'changed');
      else text.format(0, text.length, { bold: {} });
      const before = Y.encodeStateAsUpdate(doc);
      assert.throws(() => prepareNativeLinkInverse({ state: stateFor(doc), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' }),
        (error) => error instanceof NativeLinkMutationConflict && error.code === 'target-changed');
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    } finally { doc.destroy(); }
  }
});

test('plain UTF-16 targets rewrite without altering CRLF, formatting, or independent later text', () => {
  const text = '😀 [**Target**](target.md#Part)\r\n\r\nIndependent\r\n';
  const doc = createPlainTextYDoc(text);
  try {
    const state = stateFor(doc, 'plain_text');
    const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'rewrite', 'new%20name.md#Part'), operationId: 'forward' });
    Y.applyUpdate(doc, prepared.update);
    assert.equal(doc.getText('content').toString(), text.replace('target.md#Part', 'new%20name.md#Part'));
    doc.getText('content').insert(doc.getText('content').length, 'Later\r\n');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc, 'plain_text'), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update); assert.equal(doc.getText('content').toString(), `${text}Later\r\n`);
  } finally { doc.destroy(); }
});

test('plain unlink keeps exact labels, removes embeds, and restores only its authored syntax', () => {
  const text = '[**Keep**](target.md) and [[target|Alias]] ![Image](img.png)\n\nIndependent';
  const doc = createPlainTextYDoc(text);
  try {
    const state = stateFor(doc, 'plain_text');
    const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'unlink'), operationId: 'forward' });
    Y.applyUpdate(doc, prepared.update);
    assert.equal(doc.getText('content').toString(), '**Keep** and Alias \n\nIndependent');
    doc.getText('content').insert(doc.getText('content').length, ' later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc, 'plain_text'), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update); assert.equal(doc.getText('content').toString(), `${text} later`);
  } finally { doc.destroy(); }
});

test('plain Undo cannot revive a deleted empty embed slot or overwrite a newly authored target', () => {
  for (const unlink of [false, true]) {
    const doc = createPlainTextYDoc(unlink ? '![Image](img.png)\n\nIndependent' : '[Text](target.md)\n\nIndependent');
    try {
      const state = stateFor(doc, 'plain_text');
      const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, unlink ? 'unlink' : 'rewrite'), operationId: 'forward' });
      Y.applyUpdate(doc, prepared.update);
      const text = doc.getText('content');
      if (unlink) text.delete(0, 2);
      else {
        const start = text.toString().indexOf('renamed.md'); text.delete(start, 'renamed.md'.length); text.insert(start, 'different.md');
      }
      const before = text.toString();
      assert.throws(() => prepareNativeLinkInverse({ state: stateFor(doc, 'plain_text'), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' }), /target-changed/u);
      assert.equal(text.toString(), before);
    } finally { doc.destroy(); }
  }
});

test('native Wiki and image attribute rewrites preserve stable IDs, display aliases and other attributes', () => {
  const doc = createRichMarkdownYDoc('[[target#Heading|Alias]]\n\n![Alt](img.png "Title")\n\nIndependent', 'tiptap_blocks');
  try {
    const state = stateFor(doc); const inventory = inspectPersistedDocumentLinks(state);
    const selected = recipes(state, 'rewrite').map((recipe) => ({ ...recipe,
      nextValue: recipe.reference.kind === 'node-attribute' && recipe.reference.attribute === 'target' ? '/new#Heading|Alias' : '/new-image.png' }));
    const prepared = prepareNativeLinkMutations({ state, recipes: selected, operationId: 'forward' });
    Y.applyUpdate(doc, prepared.update);
    const after = inspectPersistedDocumentLinks(stateFor(doc));
    assert.deepEqual(after.links.map((link) => link.id), inventory.links.map((link) => link.id));
    assert.equal(after.links.find((link) => link.kind === 'wiki')?.alias, 'Alias');
    assert.match(JSON.stringify(authoritativeNativeCollaborationSnapshot(stateFor(doc)).content), /"alt":"Alt"/u);
    const independent = paragraphText(doc, true); independent.insert(independent.length, ' later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update);
    assert.deepEqual(hrefs(doc), inventory.links.map((link) => link.literal));
    assert.equal(independent.toString(), 'Independent later');
  } finally { doc.destroy(); }
});

test('Wiki unlink can restore its native atom after another paragraph changes', () => {
  const doc = createRichMarkdownYDoc('[[target|Alias]]\n\nIndependent', 'tiptap_blocks');
  try {
    const state = stateFor(doc); const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'unlink'), operationId: 'forward' });
    Y.applyUpdate(doc, prepared.update); assert.deepEqual(hrefs(doc), []);
    const independent = paragraphText(doc, true); independent.insert(independent.length, ' later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update); assert.deepEqual(hrefs(doc), ['target']);
    assert.equal(independent.toString(), 'Independent later');
  } finally { doc.destroy(); }
});

test('block image unlink reverts only its placement deletion and retains independent text edits', () => {
  const doc = createRichMarkdownYDoc('![Alt](img.png)\n\nIndependent', 'tiptap_blocks');
  try {
    const state = stateFor(doc); const prepared = prepareNativeLinkMutations({ state, recipes: recipes(state, 'unlink'), operationId: 'forward' });
    Y.applyUpdate(doc, prepared.update); assert.deepEqual(hrefs(doc), []);
    const independent = paragraphText(doc, true); independent.insert(independent.length, ' later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc), inverseRecipes: prepared.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update); assert.deepEqual(hrefs(doc), ['img.png']);
    assert.equal(independent.toString(), 'Independent later');
  } finally { doc.destroy(); }
});

test('legacy XML supports target-only marks, Wiki rewrites and scoped unlink restoration', () => {
  const doc = createRichMarkdownYDoc('[Text](target.md) [[wiki|Alias]]\n\nIndependent', 'tiptap_xml');
  try {
    const state = stateFor(doc, 'tiptap_xml');
    const forward = prepareNativeLinkMutations({ state, recipes: recipes(state, 'unlink'), operationId: 'forward' });
    Y.applyUpdate(doc, forward.update); assert.equal(hrefs(doc, 'tiptap_xml').length, 0);
    const paragraph = doc.getXmlFragment('body').toArray().at(-1) as Y.XmlElement;
    const text = paragraph.toArray()[0] as Y.XmlText; text.insert(text.length, ' later');
    const inverse = prepareNativeLinkInverse({ state: stateFor(doc, 'tiptap_xml'), inverseRecipes: forward.inverseRecipes, operationId: 'undo' });
    Y.applyUpdate(doc, inverse.update); assert.deepEqual(hrefs(doc, 'tiptap_xml'), ['target.md', 'wiki']);
    assert.equal(text.toString(), 'Independent later');
  } finally { doc.destroy(); }
});

test('strict forward rejects stale proof, changed identity, duplicate recipes and unbound copy anchors', () => {
  const doc = createRichMarkdownYDoc('[Text](target.md)', 'tiptap_blocks');
  try {
    const state = stateFor(doc); const original = recipes(state, 'rewrite');
    for (const changed of [{ ...state, path: 'other.md' }, { ...state, lifecycleGeneration: 2 }, { ...state, organizationId: 'foreign' }, { ...state, documentSequence: 8 }]) {
      assert.throws(() => prepareNativeLinkMutations({ state: changed, recipes: original, operationId: 'forward' }), /source-changed/u);
    }
    assert.throws(() => prepareNativeLinkMutations({ state, recipes: [...original, ...original], operationId: 'forward' }), /target-changed/u);
    assert.throws(() => prepareNativeLinkMutations({ state, recipes: [{ ...original[0], cloneSelection: 'folder' }], operationId: 'forward' }), /source-changed/u);
    const current = paragraphText(doc); current.insert(current.length, ' later');
    assert.throws(() => prepareNativeLinkMutations({ state: stateFor(doc), recipes: original, operationId: 'forward' }), /source-changed/u);
    assert.deepEqual(hrefs(doc), ['target.md']);
  } finally { doc.destroy(); }
});

test('unsupported reference unlink and removal of the sole required block fail without touching the source', () => {
  for (const [markdown, representation] of [['[Text][ref]\n\n[ref]: target.md', 'plain_text'], ['![Alt](img.png)', 'tiptap_blocks']] as const) {
    const doc = representation === 'plain_text' ? createPlainTextYDoc(markdown) : createRichMarkdownYDoc(markdown, representation);
    try {
      const state = stateFor(doc, representation); const before = Y.encodeStateAsUpdate(doc);
      assert.throws(() => prepareNativeLinkMutations({ state, recipes: recipes(state, 'unlink'), operationId: 'forward' }));
      assert.deepEqual(Y.encodeStateAsUpdate(doc), before);
    } finally { doc.destroy(); }
  }
});
