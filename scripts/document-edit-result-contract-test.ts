import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { Y } from '../app/lib/collaboration/server-runtime';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { collaborationStateProof } from '../app/lib/collaboration/state-proof';
import { documentVersionV1 } from '../app/lib/documents/read-version';
import { DocumentEditError } from '../app/lib/documents/edit-contracts';
import { decodeDocumentEditStatusRequestV1, encodeDocumentEditOperationResultV1,
  DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1, DOCUMENT_EDIT_STATUS_REQUEST_JSON_SCHEMA_V1,
  MAX_DOCUMENT_EDIT_OPERATION_RESULT_BYTES } from '../app/lib/documents/edit-result-contract';

// Pure codec/schema/Yjs-version comparison only, no authority/PG/status proof.
const identity = { workspaceId: 'contract-workspace', organizationId: null, documentId: 'contract-document',
  lineageId: 'contract-lineage', lifecycleGeneration: 1, representation: 'plain_text' as const, schemaVersion: 1 };
const pending = () => ({ apiVersion: 1, operationId: 'contract-operation', state: 'pending', document: { kind: 'native_document', ...identity },
  effect: null, persistence: { status: 'unconfirmed', confirmedInSequence: null, confirmedAt: null },
  projection: { status: 'unconfirmed', checkpointedAt: null, revisionId: null }, history: { status: 'unconfirmed', revisionId: null } });
const invalid = (error: unknown): boolean => { assert(error instanceof DocumentEditError); assert.equal(error.code, 'INVALID_REQUEST'); return true; };
let groups = 0;
const check = (name: string, action: () => void) => { action(); groups++; console.log('PASS edit operation result contract:', name); };
export function documentEditResultContractTest(): void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validate = ajv.compile(DOCUMENT_EDIT_OPERATION_RESULT_JSON_SCHEMA_V1), requestSchema = ajv.compile(DOCUMENT_EDIT_STATUS_REQUEST_JSON_SCHEMA_V1);
  const doc = createPlainTextYDoc('ABCDE');
  try {
    const first = collaborationStateProof(doc, Y); assert(first); const vector = Y.encodeStateVector(doc), beforeVersion = documentVersionV1(identity, first);
    doc.getText('content').delete(1, 2); assert.deepEqual(Y.encodeStateVector(doc), vector);
    const deleted = collaborationStateProof(doc, Y); assert(deleted); const afterVersion = documentVersionV1(identity, deleted); assert.notEqual(beforeVersion, afterVersion);
    const effect = { outcome: 'applied', beforeVersion, afterVersion, appliedAt: 100 };
    const confirmed = () => ({ ...pending(), state: 'confirmed', effect: { ...effect },
      persistence: { status: 'confirmed', confirmedInSequence: 91, confirmedAt: 200 } });
    check('historical full-version effect stays separate from recorded later sequence, projection and history', () => {
      const result = encodeDocumentEditOperationResultV1(confirmed()); assert(validate(result), ajv.errorsText(validate.errors));
      assert.equal(result.effect?.afterVersion, afterVersion); assert.equal(result.persistence.confirmedInSequence, 91);
      assert.equal(Object.hasOwn(result, 'currency'), false); assert.equal(Object.hasOwn(result.document, 'version'), false);
      assert.equal(Object.hasOwn(result.document, 'path'), false); assert.equal(Object.hasOwn(result.document, 'title'), false);
      assert.equal(Object.hasOwn(result.document, 'metadataVersion'), false);
      assert(Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_DOCUMENT_EDIT_OPERATION_RESULT_BYTES);
      const checkpoint = encodeDocumentEditOperationResultV1({ ...confirmed(), projection: { status: 'checkpointed', checkpointedAt: 300, revisionId: 'physical-revision' },
        history: { status: 'captured', revisionId: 'history-revision' } }); assert(validate(checkpoint));
      const noOp = encodeDocumentEditOperationResultV1({ ...confirmed(), effect: { ...effect, outcome: 'no_change', afterVersion: beforeVersion } }); assert(validate(noOp));
      for (const state of ['pending', 'conflict', 'failed']) assert(validate(encodeDocumentEditOperationResultV1({ ...pending(), state })));
      assert(validate(encodeDocumentEditOperationResultV1({ ...pending(), effect, history: { status: 'over_limit', revisionId: null } })));
    });
    check('strict shape and crossfield false confirmations fail before a DTO can escape', () => {
      const contradictions = [
        { ...pending(), persistence: { status: 'confirmed', confirmedInSequence: 3, confirmedAt: 200 } },
        { ...confirmed(), effect: null }, { ...confirmed(), state: 'failed' },
        { ...pending(), projection: { status: 'checkpointed', checkpointedAt: 300, revisionId: 'revision' } },
        { ...pending(), history: { status: 'captured', revisionId: 'revision' } },
        { ...pending(), history: { status: 'over_limit', revisionId: null } },
        { ...pending(), persistence: { status: 'unconfirmed', confirmedInSequence: 3, confirmedAt: null } },
        { ...confirmed(), extra: true }, { ...confirmed(), document: { ...pending().document, path: 'invented.md' } },
      ];
      for (const input of contradictions) { assert.throws(() => encodeDocumentEditOperationResultV1(input), invalid); assert.equal(validate(input), false); }
      assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), effect: { ...effect, outcome: 'no_change' } }), invalid);
      assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), effect: { ...effect, afterVersion: beforeVersion } }), invalid);
      assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), persistence: { status: 'confirmed', confirmedInSequence: 91, confirmedAt: 99 } }), invalid);
      assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), projection: { status: 'checkpointed', checkpointedAt: 199, revisionId: 'revision' } }), invalid);
    });
    check('request/DTO reflection executes no getter or Proxy trap and output is detached and frozen', () => {
      let traps = 0;
      const proxy = new Proxy({}, { get() { traps++; throw new Error('get'); }, ownKeys() { traps++; throw new Error('keys'); },
        getPrototypeOf() { traps++; throw new Error('prototype'); } });
      assert.throws(() => decodeDocumentEditStatusRequestV1(proxy), invalid); assert.throws(() => encodeDocumentEditOperationResultV1(proxy), invalid);
      assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), document: proxy }), invalid);
      const getter = Object.defineProperty({}, 'apiVersion', { enumerable: true, get() { traps++; return 1; } });
      assert.throws(() => decodeDocumentEditStatusRequestV1(getter), invalid);
      const revoked = Proxy.revocable({}, {}); revoked.revoke(); assert.throws(() => encodeDocumentEditOperationResultV1(revoked.proxy), invalid);
      assert.equal(traps, 0);
      const input = confirmed(), output = encodeDocumentEditOperationResultV1(input); input.effect.afterVersion = beforeVersion;
      assert.equal(output.effect?.afterVersion, afterVersion); assert(Object.isFrozen(output));
      for (const child of [output.document, output.effect, output.persistence, output.projection, output.history]) assert(Object.isFrozen(child));
    });
    check('status selection and safe counters reject reserved fields, invalid IDs and nonfinite facts', () => {
      const request = { apiVersion: 1, workspaceId: identity.workspaceId, operationId: 'operation-1' };
      assert(requestSchema(request)); const decoded = decodeDocumentEditStatusRequestV1(request); assert.deepEqual(decoded, request); assert(Object.isFrozen(decoded));
      for (const input of [{ ...request, documentId: identity.documentId }, { ...request, path: 'old.md' }, { ...request, apiVersion: 2 },
        { ...request, workspaceId: '\ud800' }, { ...request, operationId: 'a'.repeat(129) }, { ...request, operationId: '../operation' }]) {
        assert.throws(() => decodeDocumentEditStatusRequestV1(input), invalid);
      }
      for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => encodeDocumentEditOperationResultV1({ ...confirmed(), persistence: { status: 'confirmed', confirmedInSequence: bad, confirmedAt: 200 } }), invalid);
      }
    });
  } finally { doc.destroy(); }
  assert.equal(groups, 4); console.log('Edit operation result contracts:', groups, 'pure groups; no authority/status/durability claim.');
}
documentEditResultContractTest();
