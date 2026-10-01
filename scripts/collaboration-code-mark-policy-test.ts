import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createRichMarkdownYDoc, validateRichMarkdownYDoc, richMarkdownFromYDoc } from '../app/lib/collaboration/markdown-state';
import { BLOCK_TREE_KEY } from '../app/lib/collaboration/block-tree';
import { readRichDocumentJson } from '../app/lib/collaboration/rich-document';
import { mergeCollaborationPersistenceUpdates } from '../app/lib/collaboration/persistence-merge';
import { hasCodeMarkConflicts, installCodeMarkConflictPolicy, normalizeCodeMarkConflicts, normalizeNewCodeMarkConflicts } from '../app/lib/collaboration/code-mark-policy';
import { prepareCodeMarkConflictRepair } from '../app/lib/collaboration/code-mark-repair';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type * as Persistence from '../app/lib/collaboration/persistence';
import { createPiTestDatabase } from './helpers/pi-test-database';
import { richMarkdownCodecExtensions } from '../app/lib/markdown/rich-markdown-codec';
import { createRichEditorCollaborationExtensions, isRemoteRichEditorTransaction } from '../app/lib/collaboration/rich-editor-extensions';
import { CanvasUniqueID } from '../app/lib/editor/canvas-unique-id';

function text(doc: InstanceType<typeof Y.Doc>): InstanceType<typeof Y.XmlText> {
  const texts: InstanceType<typeof Y.XmlText>[] = [];
  const visit = (fragment: InstanceType<typeof Y.XmlFragment>) => {
    for (const child of fragment.toArray()) {
      if (child instanceof Y.XmlText) texts.push(child);
      else if (child instanceof Y.XmlElement) visit(child);
    }
  };
  if (doc.share.has(BLOCK_TREE_KEY)) {
    const records = doc.getMap(BLOCK_TREE_KEY).get('records');
    assert(records instanceof Y.Map);
    for (const record of records.values()) {
      assert(record instanceof Y.Map);
      const content = record.get('content'); assert(content instanceof Y.XmlFragment); visit(content);
    }
  } else visit(doc.getXmlFragment('body'));
  assert.equal(texts.length, 1); return texts[0];
}

function state(doc: InstanceType<typeof Y.Doc>, representation: 'tiptap_xml' | 'tiptap_blocks'): PersistedCollaborationState {
  return { documentId: 'doc', workspaceId: 'ws', organizationId: 'org', path: 'note.md', representation,
    lifecycleGeneration: 4, schemaVersion: 1, documentSequence: 8, checkpointSequence: 7,
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc), status: 'active',
    persistedAt: 1, checkpointedAt: 1, canonicalHash: null, serializedHash: null, newlineStyle: 'crlf', hasBom: true, degraded: true };
}

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: Code wins convergently; historical repair preserves evidence and identity`, () => {
  const seed = createRichMarkdownYDoc('---\ntitle: Original\n---\n\nAlpha 😀 Beta\n', representation);
  const code = new Y.Doc({ gc: false }); const bold = new Y.Doc({ gc: false }); const raw = new Y.Doc({ gc: false });
  const documents = [seed, code, bold, raw];
  const original = Y.encodeStateAsUpdate(seed);
  try {
    for (const doc of [code, bold, raw]) Y.applyUpdate(doc, original);
    text(code).format(0, text(code).length, { code: {} });
    text(bold).format(0, text(bold).length, { bold: {} });
    assert.equal(validateRichMarkdownYDoc(code).valid, true);
    assert.equal(validateRichMarkdownYDoc(bold).valid, true);
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(code)); Y.applyUpdate(raw, Y.encodeStateAsUpdate(bold));
    assert.equal(validateRichMarkdownYDoc(raw).code, 'schema_invalid');
    const rawBytes = Y.encodeStateAsUpdate(raw);
    const repaired = prepareCodeMarkConflictRepair(state(raw, representation));
    assert.deepEqual(repaired.originalYjsState, rawBytes);
    assert.deepEqual(repaired.lostFormatting, [{ mark: 'bold', utf16Units: text(raw).length }]);
    assert.deepEqual(prepareCodeMarkConflictRepair(state(raw, representation)).repairedYjsState, repaired.repairedYjsState);
    assert.equal(repaired.identity.documentId, 'doc'); assert.equal(repaired.identity.lifecycleGeneration, 4);
    assert.deepEqual(repaired.encoding, { hasBom: true, newlineStyle: 'crlf' });
    assert.deepEqual(Y.encodeStateAsUpdate(raw), rawBytes, 'repair and serialization never mutate original evidence');
    assert.equal(normalizeNewCodeMarkConflicts(rawBytes, rawBytes), null, 'ordinary save never repairs a historical conflict');
    let expected: unknown;
    for (const [current, incoming] of [[code, bold], [bold, code]]) {
      const union = mergeCollaborationPersistenceUpdates(Y.encodeStateAsUpdate(current), Y.encodeStateAsUpdate(incoming));
      const normalized = normalizeNewCodeMarkConflicts(Y.encodeStateAsUpdate(current), union.update); assert(normalized);
      const result = new Y.Doc({ gc: false }); documents.push(result); Y.applyUpdate(result, normalized.update);
      assert.equal(validateRichMarkdownYDoc(result).valid, true);
      assert.equal(text(result).toDelta().map((part: { insert: unknown }) => part.insert).join(''), text(seed).toDelta().map((part: { insert: unknown }) => part.insert).join(''));
      assert.equal(result.getText('frontmatter').toString(), seed.getText('frontmatter').toString());
      assert.equal(result.getText('bodyFinalLineEnding').toString(), seed.getText('bodyFinalLineEnding').toString());
      assert.deepEqual(normalizeCodeMarkConflicts(result), [], 'normalization is a fixed point');
      const json = readRichDocumentJson(result); if (expected) assert.deepEqual(json, expected); expected = json;
      assert(richMarkdownFromYDoc(result).includes('`Alpha 😀 Beta`'));
      // Receiving the discarded Bold replica again must not restore its mark.
      Y.applyUpdate(result, Y.encodeStateAsUpdate(bold)); assert.equal(hasCodeMarkConflicts(result), false);
    }
    const live = new Y.Doc({ gc: false }); documents.push(live); Y.applyUpdate(live, original);
    const controller = new AbortController(); let writable = true;
    const policy = installCodeMarkConflictPolicy(live, { signal: controller.signal, canNormalize: () => writable }); policy.activate();
    Y.applyUpdate(live, Y.encodeStateAsUpdate(code)); Y.applyUpdate(live, Y.encodeStateAsUpdate(bold));
    assert.equal(hasCodeMarkConflicts(live), false); assert.deepEqual(readRichDocumentJson(live), expected);
    writable = false; controller.abort();
    const historicalController = new AbortController();
    const historical = installCodeMarkConflictPolicy(raw, { signal: historicalController.signal, canNormalize: () => true }); historical.activate();
    text(raw).insert(text(raw).length, '!'); assert.equal(hasCodeMarkConflicts(raw), true, 'opening or editing a conflicting baseline does not repair it');
    historicalController.abort();
  } finally { for (const doc of documents) doc.destroy(); }
});

for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) test(`${representation}: actual editor binding observes Code priority without invalid schema or ID churn`, async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'DOMParser', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
  }
  const live = createRichMarkdownYDoc('Alpha 😀 Beta', representation);
  const code = new Y.Doc(); const bold = new Y.Doc();
  const original = Y.encodeStateAsUpdate(live); for (const doc of [code, bold]) Y.applyUpdate(doc, original);
  text(code).format(0, text(code).length, { code: {} }); text(bold).format(0, text(bold).length, { bold: {} });
  const controller = new AbortController();
  const policy = installCodeMarkConflictPolicy(live, { signal: controller.signal, canNormalize: () => true }); policy.activate();
  const errors: Error[] = [];
  const editor = new Editor({ extensions: [
    ...richMarkdownCodecExtensions().map((extension) => extension.name === 'starterKit' ? extension.configure({ undoRedo: false })
      : extension.name === 'uniqueID' ? CanvasUniqueID.configure({ types: 'all', filterTransaction: (transaction) => !isRemoteRichEditorTransaction(transaction) }) : extension),
    ...createRichEditorCollaborationExtensions({ document: live, representation, awareness: null,
      user: { name: 'Peer', color: '#123456' }, onError: (error) => errors.push(error) }),
  ] });
  try {
    await Promise.resolve(); const id = editor.state.doc.firstChild!.attrs.id;
    Y.applyUpdate(live, Y.encodeStateAsUpdate(code)); Y.applyUpdate(live, Y.encodeStateAsUpdate(bold));
    await Promise.resolve();
    editor.state.doc.check(); assert.equal(editor.state.doc.textContent, 'Alpha 😀 Beta');
    assert.equal(editor.state.doc.firstChild!.attrs.id, id);
    assert.deepEqual(editor.state.doc.firstChild!.firstChild!.marks.map((mark) => mark.type.name), ['code']);
    assert.deepEqual(errors, []); assert.equal(validateRichMarkdownYDoc(live).valid, true);
  } finally {
    controller.abort(); editor.destroy(); live.destroy(); code.destroy(); bold.destroy();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test('real SQL persistence normalizes only new conflicts, reconciles the room and preserves quarantine', async () => {
  const database = await createPiTestDatabase(); const connection = await database.openDb();
  const filename = path.resolve('app/lib/collaboration/persistence.ts'); const require = createRequire(filename);
  const source = ts.transpileModule(await readFile(filename, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  const persistence = {} as typeof Persistence;
  new Function('require', 'module', 'exports', source)((name: string) => name === '@/app/lib/db' ? database : require(name), { exports: persistence }, persistence);
  const seed = createRichMarkdownYDoc('Alpha', 'tiptap_xml'); const code = new Y.Doc({ gc: false }); const bold = new Y.Doc({ gc: false });
  const raw = new Y.Doc({ gc: false }); const documents = [seed, code, bold, raw];
  try {
    for (const doc of [code, bold, raw]) Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    text(code).format(0, text(code).length, { code: {} }); text(bold).format(0, text(bold).length, { bold: {} });
    await connection.run(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,path,representation,yjs_state,state_vector,
      document_sequence,checkpoint_sequence,persisted_at) VALUES ('marks','ws','note.md','tiptap_xml',$1,$2,1,0,1)`,
    [Y.encodeStateAsUpdate(code), Y.encodeStateVector(code)]);
    const saved = await persistence.persistCollaborationYDoc('marks', 1, bold);
    assert.equal(saved.incomingNeedsReconcile, true); assert.equal(saved.documentSequence, 2);
    const normalized = new Y.Doc(); documents.push(normalized); Y.applyUpdate(normalized, saved.yjsState);
    assert.equal(validateRichMarkdownYDoc(normalized).valid, true);
    assert.equal((await persistence.persistCollaborationYDoc('marks', 1, bold)).documentSequence, 2);
    Y.applyUpdate(raw, Y.encodeStateAsUpdate(code)); Y.applyUpdate(raw, Y.encodeStateAsUpdate(bold));
    const originalConflict = Y.encodeStateAsUpdate(raw);
    await connection.run(`UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2,degraded=1,
      projection_error_code='COLLABORATION_SCHEMA_INVALID',projection_error_permanent=1,projection_error_generation=1 WHERE document_id='marks'`,
    [originalConflict, Y.encodeStateVector(raw)]);
    text(raw).insert(text(raw).length, '!');
    const quarantined = await persistence.persistCollaborationYDoc('marks', 1, raw);
    assert.equal(quarantined.degraded, true); assert.equal(quarantined.projectionError?.permanent, true);
    const retained = new Y.Doc(); documents.push(retained); Y.applyUpdate(retained, quarantined.yjsState);
    assert.equal(hasCodeMarkConflicts(retained), true, 'ordinary save never repairs the quarantined state');
    text(retained).format(0, 1, { unknownPrivateMark: {} });
    normalizeCodeMarkConflicts(retained);
    assert(text(retained).toDelta().some((part: { attributes?: Record<string, unknown> }) => Object.hasOwn(part.attributes ?? {}, 'unknownPrivateMark')),
      'unsupported marks are preserved for schema quarantine');
  } finally { for (const doc of documents) doc.destroy(); await database.close(); }
});
