import assert from 'node:assert/strict';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc, createRichMarkdownYDoc } from '../app/lib/collaboration/markdown-state';
import { inspectNativeDocument } from '../app/lib/collaboration/document-snapshot';
import { nativeCollaborationSearchText } from '../app/lib/collaboration/workspace-search-reader';
import { DocumentReadError } from '../app/lib/documents/contracts';
import { decodeDocumentSearchRequestV1, DocumentSearchError } from '../app/lib/documents/search-contract';
import { assertNativeDocumentWithinReadBudget, captureNativeDocumentReadBudget,
  NATIVE_SEARCH_DOCUMENT_BUDGET } from '../app/lib/collaboration/native-search-budget';

// Mechanical decoder/budget tests with actual Yjs and native semantic content.
// These assertions establish neither a SQL principal nor room ownership.
let groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) process.exitCode = 1; });
const readError = (code: DocumentReadError['code']) => (error: unknown) =>
  error instanceof DocumentReadError && error.code === code;
const invalid = (value: unknown) => assert.throws(() => decodeDocumentSearchRequestV1(value),
  (error: unknown) => error instanceof DocumentSearchError && error.code === 'INVALID_SEARCH_REQUEST' && error.status === 400);

export async function nativeDocumentSearchContractTest(): Promise<void> {
  const request = { apiVersion: 1, workspaceId: 'workspace-search', query: '  A.[*] 😀  ' };
  const selected = decodeDocumentSearchRequestV1(request);
  assert.deepEqual(selected, { apiVersion: 1, workspaceId: request.workspaceId, query: 'A.[*] 😀', scopePath: '.', limit: 8 });
  assert(Object.isFrozen(selected)); request.query = 'changed'; assert.equal(selected.query, 'A.[*] 😀');
  assert.equal(decodeDocumentSearchRequestV1({ ...request, query: '😀😀', scopePath: 'folder_%/literal', limit: 25 }).limit, 25);
  assert.equal(decodeDocumentSearchRequestV1({ ...request, query: 'é'.repeat(100) }).query.length, 100);
  for (const query of ['', 'x', '😀', '\ud800a', 'a\udfff', 'a\nB', 'ab\u007f', 'é'.repeat(101)]) invalid({ ...request, query });
  for (const scopePath of ['', '/absolute', 'a//b', 'a/../b', './a', 'a\\b', 'a/\ud800']) invalid({ ...request, query: 'ab', scopePath });
  for (const limit of [null, 0, 26, 1.1, NaN, Infinity, '8']) invalid({ ...request, query: 'ab', limit });
  for (const cursor of [null, '', 'a+b', 'x'.repeat(4097)]) invalid({ ...request, query: 'ab', cursor });
  invalid({ ...request, query: 'ab', workspaceId: 'workspace-\ud800' });
  invalid({ ...request, query: 'ab', unknown: true }); invalid(Object.create(null));
  let traps = 0;
  const getter = { ...request, query: 'ab' };
  Object.defineProperty(getter, 'query', { enumerable: true, get() { traps++; throw new Error('Getter must not run.'); } });
  invalid(getter);
  const proxy = new Proxy({ ...request, query: 'ab' }, { ownKeys() { traps++; throw new Error('Proxy must not run.'); },
    getPrototypeOf() { traps++; throw new Error('Proxy must not run.'); } });
  invalid(proxy);
  const revoked = Proxy.revocable({ ...request, query: 'ab' }, {}); revoked.revoke(); invalid(revoked.proxy);
  assert.equal(traps, 0);
  console.log('PASS native search strict request data, literal queries and Unicode bounds'); groups++;

  const budget = captureNativeDocumentReadBudget(NATIVE_SEARCH_DOCUMENT_BUDGET);
  assert(Object.isFrozen(budget)); assert.deepEqual(budget, NATIVE_SEARCH_DOCUMENT_BUDGET);
  for (const value of [{ ...budget, maxNodes: 0 }, { ...budget, maxStateBytes: 64 * 1024 * 1024 + 1 },
    { ...budget, maxDepth: 2.5 }, { ...budget, extra: 1 }]) {
    assert.throws(() => captureNativeDocumentReadBudget(value), readError('INVALID_REQUEST'));
  }
  const doc = createPlainTextYDoc('actual text 😀');
  const retained = new Y.Doc({ gc: false });
  const binary = new Y.Doc(), nested = new Y.Doc(), pending = new Y.Doc(), sender = new Y.Doc(), formatted = new Y.Doc({ gc: false });
  try {
    const text = doc.getText('content');
    Object.defineProperty(text, 'toJSON', { value: () => assert.fail('Budget must precede materialization.') });
    Object.defineProperty(text, 'toDelta', { value: () => assert.fail('Budget must precede materialization.') });
    for (const structs of doc.store.clients.values()) for (const struct of structs) {
      if ('content' in struct) Object.defineProperty(struct.content, 'getContent', {
        configurable: true, value: () => assert.fail('Budget must inspect content fields, not expand characters.') });
    }
    assertNativeDocumentWithinReadBudget(doc, budget);
    assert.throws(() => assertNativeDocumentWithinReadBudget(doc, { ...budget, maxStringBytes: 8 }), readError('DOCUMENT_TOO_LARGE'));
    const deleted = retained.getText('content'); deleted.insert(0, 'retained-history'.repeat(20)); deleted.delete(0, deleted.length);
    assert.equal(deleted.toString(), '');
    assert.throws(() => assertNativeDocumentWithinReadBudget(retained, { ...budget, maxStringBytes: 32 }), readError('DOCUMENT_TOO_LARGE'));
    binary.getArray('binary').push([new Uint8Array(32)]);
    assert.throws(() => assertNativeDocumentWithinReadBudget(binary, { ...budget, maxBinaryBytes: 31 }), readError('DOCUMENT_TOO_LARGE'));
    const map = nested.getMap('json'); map.set('dense', [1, 2, 3, 4]);
    assert.throws(() => assertNativeDocumentWithinReadBudget(nested, { ...budget, maxNodes: 3 }), readError('DOCUMENT_TOO_LARGE'));
    map.set('deep', { one: { two: { three: true } } });
    assert.throws(() => assertNativeDocumentWithinReadBudget(nested, { ...budget, maxDepth: 2 }), readError('DOCUMENT_TOO_LARGE'));
    assert.throws(() => assertNativeDocumentWithinReadBudget(nested, { ...budget, maxStructs: 1 }), readError('DOCUMENT_TOO_LARGE'));
    const added = new Y.Doc();
    try { added.getText('other').insert(0, 'second client'); Y.applyUpdate(nested, Y.encodeStateAsUpdate(added)); }
    finally { added.destroy(); }
    assert.throws(() => assertNativeDocumentWithinReadBudget(nested, { ...budget, maxClients: 1 }), readError('DOCUMENT_TOO_LARGE'));
    sender.getText('content').insert(0, 'dependency'); const vector = Y.encodeStateVector(sender);
    sender.getText('content').insert(10, 'later'); Y.applyUpdate(pending, Y.encodeStateAsUpdate(sender, vector));
    assert(pending.store.pendingStructs);
    assert.throws(() => assertNativeDocumentWithinReadBudget(pending, budget), readError('DOCUMENT_STATE_INVALID'));
    // Small encoded Yjs can expand each retained format map at every segment.
    // This is an allocation-preflight counterfixture, not a schema-valid PM
    // document or an authorization proof. No toDelta/getContent may run first.
    const paragraph = new Y.XmlElement('paragraph'), xmlText = new Y.XmlText();
    formatted.getXmlFragment('body').insert(0, [paragraph]); paragraph.insert(0, [xmlText]);
    const formats: Record<string, boolean> = {};
    for (let index = 0; index < 64; index++) formats[`format_${index}`] = true;
    for (let index = 0; index < 512; index++) xmlText.insert(index, 'x', { ...formats, turn: index % 2 === 0 });
    assert(Y.encodeStateAsUpdate(formatted).byteLength < budget.maxStateBytes);
    assert([...formatted.store.clients.values()].reduce((count, entries) => count + entries.length, 0) < budget.maxStructs);
    assert.equal(xmlText.length, 512);
    Object.defineProperty(xmlText, 'toDelta', { value: () => assert.fail('Reject format amplification before toDelta.') });
    for (const entries of formatted.store.clients.values()) for (const struct of entries) {
      if ('content' in struct) Object.defineProperty(struct.content, 'getContent', {
        configurable: true, value: () => assert.fail('Reject format amplification before content expansion.') });
    }
    assert.throws(() => assertNativeDocumentWithinReadBudget(formatted, budget), readError('DOCUMENT_TOO_LARGE'));
  } finally { for (const value of [doc, retained, binary, nested, pending, sender, formatted]) value.destroy(); }
  console.log('PASS actual Yjs preflight bounds history, content, struct/client counts and pending dependencies'); groups++;

  const plain = { kind: 'plain_text' as const, text: 'a😀é' };
  assert.equal(nativeCollaborationSearchText(plain), plain.text);
  assert.equal(nativeCollaborationSearchText(plain, { maxBytes: 7 }), plain.text);
  assert.throws(() => nativeCollaborationSearchText(plain, { maxBytes: 6 }), readError('DOCUMENT_TOO_LARGE'));
  for (const representation of ['tiptap_xml', 'tiptap_blocks'] as const) {
    const rich = createRichMarkdownYDoc('---\ntitle: Header 😀\n---\n\n# Heading\n\nFirst  \nsecond\n\n- nested text\n\n| A | B |\n| --- | --- |\n| Cell | More |', representation);
    try {
      const content = inspectNativeDocument(rich, representation).content;
      const legacy = nativeCollaborationSearchText(content), bytes = Buffer.byteLength(legacy, 'utf8');
      assert.match(legacy, /Header 😀/u); assert.match(legacy, /Cell/u);
      assert.equal(nativeCollaborationSearchText(content, { maxBytes: bytes }), legacy,
        `${representation} bounded semantic extraction must retain legacy separators and frontmatter.`);
      assert.throws(() => nativeCollaborationSearchText(content, { maxBytes: bytes - 1 }), readError('DOCUMENT_TOO_LARGE'));
    } finally { rich.destroy(); }
  }
  let optionReads = 0;
  const options = Object.defineProperty({}, 'maxBytes', { enumerable: true, get() { optionReads++; return 32; } });
  assert.throws(() => nativeCollaborationSearchText(plain, options as Readonly<{ maxBytes: number }>), readError('INVALID_REQUEST'));
  assert.throws(() => nativeCollaborationSearchText(plain, new Proxy({ maxBytes: 32 }, {
    getOwnPropertyDescriptor() { optionReads++; throw new Error('Do not reflect a Proxy.'); } })), readError('INVALID_REQUEST'));
  assert.equal(optionReads, 0);
  console.log('PASS bounded semantic extraction preserves native text and enforces actual UTF-8 output'); groups++;
  assert.equal(groups, 3); completed = true;
  console.log(JSON.stringify({ suite: 'native-document-search-contract', groups, evidence: 'mechanical_actual_yjs_no_pg_authority' }));
}

nativeDocumentSearchContractTest().catch(error => {
  console.error(JSON.stringify({ suite: 'native-document-search-contract', groups, name: error instanceof Error ? error.name : 'UnknownError',
    code: error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value ?? null : null }));
  console.error(error); process.exitCode = 1;
});
