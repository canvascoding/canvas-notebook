import assert from 'node:assert/strict';
import Ajv from 'ajv';
import * as Y from 'yjs';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { DocumentReadError } from '../app/lib/documents/contracts';
import { encodeDocumentCreateMutationResultV1, type DocumentCreateMutationFactsV1 } from '../app/lib/documents/create-mutation-result';
import { DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1 } from '../app/lib/documents/create-mutation-result-json-schema';
import { documentMetadataVersionV1, documentVersionV1, type DocumentVersionIdentityV1 } from '../app/lib/documents/read-version';

const identity: DocumentVersionIdentityV1 = { workspaceId: 'workspace-one', organizationId: null,
  documentId: 'document-one', lineageId: 'lineage-one', lifecycleGeneration: 1, representation: 'plain_text', schemaVersion: 1 };
const proof = `yjs-snapshot-sha256-v1:${'a'.repeat(64)}`;
const facts: DocumentCreateMutationFactsV1 = { ...identity, operationId: 'operation-one', outcome: 'created',
  fullStateProof: proof, path: 'notes/First.MARKDOWN', metadataTitle: null, metadataRevision: null,
  persistedSequence: 7, persistedAt: 100, checkpointSequence: 7, checkpointedAt: 90 };
const invalid = (error: unknown) => error instanceof DocumentReadError && error.code === 'INVALID_REQUEST' && error.status === 400;
let groups = 0, completed = false;
process.once('beforeExit', () => { if (!completed) { console.error('Create result contract suite did not finish.'); process.exitCode = 1; } });

/** Mechanical facts/codec/schema acceptance only. No DB, authority or commit
 * completion is mocked, exercised or certified by these synchronous tests. */
export function documentCreateMutationResultContractsTest(): void {
  for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
    for (const outcome of ['created', 'already_created'] as const) {
      const selectedIdentity = { ...identity, representation }, input = { ...facts, representation, outcome };
      const result = encodeDocumentCreateMutationResultV1(input), version = documentVersionV1(selectedIdentity, proof);
      assert.deepEqual(result, { apiVersion: 1, operationId: facts.operationId, outcome,
        document: { kind: 'native_document', ...selectedIdentity, path: facts.path, title: 'First', version,
          metadataVersion: documentMetadataVersionV1(selectedIdentity, { path: facts.path, title: 'First', metadataRevision: null }) },
        currency: { source: 'persisted_yjs', observedVersion: version, observedDurable: true,
          durableVersion: version, durableSequence: 7, persistedAt: 100 },
        projection: { checkpointSequence: 7, checkpointedAt: 90, status: 'current' },
      });
      assert.deepEqual(Object.keys(result).sort(), ['apiVersion', 'operationId', 'outcome', 'document', 'currency', 'projection'].sort());
    }
  }
  console.log('PASS exact six-field confirmed result reuses both existing version domains for Plain/XML/Blocks'); groups++;

  const absent = encodeDocumentCreateMutationResultV1(facts);
  const nullTitle = encodeDocumentCreateMutationResultV1({ ...facts, metadataRevision: 9 });
  assert.equal(nullTitle.document.title, absent.document.title);
  assert.notEqual(nullTitle.document.metadataVersion, absent.document.metadataVersion);
  for (const title of ['', '  ', 'Frühstück 🦊 / 日本語', '😀'.repeat(2048)]) {
    const result = encodeDocumentCreateMutationResultV1({ ...facts, metadataTitle: title, metadataRevision: 0 });
    assert.equal(result.document.title, title, 'Real metadata title is preserved exactly, including empty/whitespace.');
    assert.equal(result.document.version, absent.document.version);
    assert.equal(result.document.metadataVersion, documentMetadataVersionV1(identity, { path: facts.path, title, metadataRevision: 0 }));
  }
  const moved = encodeDocumentCreateMutationResultV1({ ...facts, path: 'renamed/foreign.bin' });
  assert.equal(moved.document.title, 'foreign.bin'); assert.equal(moved.document.version, absent.document.version);
  assert.notEqual(moved.document.metadataVersion, absent.document.metadataVersion);
  console.log('PASS observed metadata absence, null title with real revision, Unicode and exact display-name semantics'); groups++;

  const doc = new Y.Doc({ gc: false });
  try {
    doc.getText('content').insert(0, 'Keep A and B');
    const vector = Y.encodeStateVector(doc), beforeProof = collaborationStateProof(doc, Y); assert(beforeProof);
    const before = encodeDocumentCreateMutationResultV1({ ...facts, fullStateProof: beforeProof });
    doc.getText('content').delete(5, 2);
    assert.deepEqual(Y.encodeStateVector(doc), vector);
    const afterProof = collaborationStateProof(doc, Y); assert(afterProof); assert.notEqual(beforeProof, afterProof);
    const after = encodeDocumentCreateMutationResultV1({ ...facts, fullStateProof: afterProof });
    assert.notEqual(after.document.version, before.document.version);
    assert.equal(after.document.metadataVersion, before.document.metadataVersion);
    assert.equal(after.currency.observedVersion, after.document.version); assert.equal(after.currency.durableVersion, after.document.version);
  } finally { doc.destroy(); }
  const original = encodeDocumentCreateMutationResultV1(facts);
  for (const change of [{ workspaceId: 'workspace-two' }, { organizationId: 'organization-two' }, { documentId: 'document-two' },
    { lineageId: 'lineage-two' }, { lifecycleGeneration: 2 }, { representation: 'tiptap_xml' }, { schemaVersion: 2 }]) {
    const result = encodeDocumentCreateMutationResultV1({ ...facts, ...change });
    assert.notEqual(result.document.version, original.document.version);
    assert.notEqual(result.document.metadataVersion, original.document.metadataVersion);
  }
  console.log('PASS actual Yjs deletion evidence and every primitive identity field bind the complete native versions'); groups++;

  let traps = 0;
  for (const key of Object.keys(facts)) {
    const getter = { ...facts }, missing: Record<string, unknown> = { ...facts };
    Object.defineProperty(getter, key, { enumerable: true, get() { traps++; throw new Error('Do not invoke source getters.'); } });
    assert.throws(() => encodeDocumentCreateMutationResultV1(getter), invalid);
    delete missing[key]; assert.throws(() => encodeDocumentCreateMutationResultV1(missing), invalid);
  }
  const extraGetter = { ...facts }, hidden = { ...facts };
  Object.defineProperty(extraGetter, 'sourceBinding', { enumerable: true, get() { traps++; throw new Error('Do not invoke extra getters.'); } });
  Object.defineProperty(hidden, 'operationId', { value: facts.operationId, enumerable: false });
  const proxy = new Proxy({ ...facts }, { ownKeys() { traps++; throw new Error('Do not reflect Proxy.'); },
    getPrototypeOf() { traps++; throw new Error('Do not reflect Proxy.'); }, get() { traps++; throw new Error('Do not read Proxy.'); } });
  const revoked = Proxy.revocable({ ...facts }, {}); revoked.revoke();
  for (const value of [extraGetter, hidden, proxy, revoked.proxy, { ...facts, [Symbol('private')]: true }, { ...facts, extra: true },
    Object.assign(Object.create(null), facts), Object.assign(Object.create({}), facts), [], null, () => facts]) {
    assert.throws(() => encodeDocumentCreateMutationResultV1(value), invalid);
  }
  assert.equal(traps, 0);
  console.log('PASS exact mandatory input rejects missing/extra/accessor/hidden/inherited/Proxy facts without traps'); groups++;

  for (const change of [{ operationId: '' }, { operationId: ' operation-one' }, { operationId: 'x'.repeat(257) },
    { outcome: 'pending' }, { workspaceId: 'workspace-\ud800' }, { documentId: '' }, { lineageId: null },
    { organizationId: undefined }, { lifecycleGeneration: 0 }, { representation: 'markdown' }, { schemaVersion: 1.5 },
    { fullStateProof: 'AA==' }, { fullStateProof: 'a'.repeat(64) }, { path: '../escape.md' }, { path: 'notes/\ud800.md' },
    { metadataTitle: 'Title', metadataRevision: null }, { metadataTitle: undefined }, { metadataTitle: '\ud800' },
    { metadataTitle: 'x'.repeat(4097), metadataRevision: 1 }, { metadataRevision: -1 }, { metadataRevision: undefined },
    { persistedSequence: 0, checkpointSequence: 1 }, { checkpointSequence: 6 }, { checkpointedAt: null }]) {
    assert.throws(() => encodeDocumentCreateMutationResultV1({ ...facts, ...change }), invalid);
  }
  for (const key of ['persistedSequence', 'persistedAt', 'checkpointSequence', 'checkpointedAt', 'metadataRevision']) {
    for (const value of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '7', undefined]) {
      assert.throws(() => encodeDocumentCreateMutationResultV1({ ...facts, [key]: value }), invalid);
    }
  }
  console.log('PASS invalid primitives, incomplete durability, missing metadata and projection progress cannot produce success'); groups++;

  const input = { ...facts }, result = encodeDocumentCreateMutationResultV1(input);
  input.metadataTitle = 'Later'; input.metadataRevision = 99; input.documentId = 'later-document';
  assert.equal(result.document.documentId, facts.documentId); assert.equal(result.document.title, 'First');
  for (const value of [result, result.document, result.currency, result.projection]) assert(Object.isFrozen(value));
  assert.equal(Reflect.set(result.document, 'title', 'Tamper'), false);
  const validate = new Ajv({ strict: true }).compile(DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1);
  assert(validate(result), JSON.stringify(validate.errors));
  assert(validate(encodeDocumentCreateMutationResultV1({ ...facts, outcome: 'already_created' })));
  for (const value of [{ status: 'created', operation_id: 'legacy', document_id: null }, { ...result, apiVersion: 2 },
    { ...result, sourceBinding: {} }, { ...result, outcome: 'pending' }, { ...result, document: { ...result.document, actorUserId: 'private' } },
    { ...result, document: { ...result.document, documentId: null } }, { ...result, currency: { ...result.currency, source: 'live_yjs' } },
    { ...result, currency: { ...result.currency, observedDurable: false } }, { ...result, projection: { ...result.projection, status: 'pending' } },
    { ...result, projection: { ...result.projection, checkpointedAt: null } }, { ...result, projection: { ...result.projection, errorCode: 'private' } }]) {
    assert.equal(validate(value), false);
  }
  function frozenSchema(value: unknown): void {
    if (value && typeof value === 'object') { assert(Object.isFrozen(value)); for (const child of Object.values(value)) frozenSchema(child); }
  }
  frozenSchema(DOCUMENT_CREATE_MUTATION_RESULT_JSON_SCHEMA_V1);
  console.log('PASS detached frozen result and strict public schema exclude legacy/private/incomplete output'); groups++;
  assert.equal(groups, 6); completed = true;
  console.log(JSON.stringify({ suite: 'document-create-mutation-result-contracts', groups, evidence: 'pure_codec_actual_yjs_no_authority_or_commit' }));
}

try { documentCreateMutationResultContractsTest(); }
catch (error) {
  console.error(JSON.stringify({ suite: 'document-create-mutation-result-contracts', groups,
    name: error instanceof Error ? error.name : 'UnknownError', code: error instanceof DocumentReadError ? error.code : null }));
  console.error(error); process.exitCode = 1;
}
