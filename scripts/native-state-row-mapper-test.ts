import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { createPlainTextYDoc } from '../app/lib/collaboration/markdown-state';
import { authoritativeNativeCollaborationSnapshot } from '../app/lib/collaboration/document-snapshot';
import { COLLABORATION_FAILURE_CODES, isCollaborationStateQuarantined } from '../app/lib/collaboration/failure';
import { mapValidatedNativeStateRow, NativeSessionStateReaderError } from '../app/lib/collaboration/native-session-state-reader';

function row() {
  const doc = createPlainTextYDoc('Literal\t😀\r\n');
  try { return { document_id: 'row-doc', workspace_id: 'row-ws', organization_id: null, path: ' literal .md',
    representation: 'plain_text', lifecycle_generation: '3', schema_version: '1', status: 'active',
    yjs_state: Y.encodeStateAsUpdate(doc), state_vector: Y.encodeStateVector(doc), document_sequence: '7', persisted_at: '100',
    checkpoint_sequence: '0', checkpointed_at: null, canonical_hash: null, serialized_hash: null, newline_style: 'crlf',
    has_bom: '0', degraded: '0', projection_error_code: null, projection_error_sequence: null,
    projection_error_generation: null, projection_error_phase: null, projection_error_permanent: '0' };
  } finally { doc.destroy(); }
}

test('already-read mapper preserves exact native bytes/proof and all genuine SQL zero/one encodings', async () => {
  let expectedProof: string | undefined;
  const raw = row();
  for (const flag of [0, 1, '0', '1', false, true]) {
    const candidate = { ...raw, has_bom: flag }, before = structuredClone(candidate);
    const state = await mapValidatedNativeStateRow(candidate, 'row-doc'); assert(state);
    assert.equal(state.hasBom, flag === 1 || flag === '1' || flag === true); assert.equal(state.degraded, false);
    assert.equal(state.newlineStyle, 'crlf'); assert.equal(state.path, ' literal .md');
    assert.deepEqual(state.yjsState, raw.yjs_state); assert.deepEqual(state.stateVector, raw.state_vector);
    assert.equal(state.yjsState.buffer, raw.yjs_state.buffer); assert.equal(state.stateVector.buffer, raw.state_vector.buffer);
    assert.equal(state.documentSequence, 7); assert.equal(state.persistedAt, 100);
    const snapshot = authoritativeNativeCollaborationSnapshot(state);
    expectedProof ??= snapshot.version.stateProof; assert.equal(snapshot.version.stateProof, expectedProof);
    assert.deepEqual(candidate, before);
  }
});

test('mapper retains genuine permanent quarantine and classified storage-retry semantics', async () => {
  for (const permanent of [0, '0', 1, '1']) {
    const raw = { ...row(), degraded: '1', projection_error_code: COLLABORATION_FAILURE_CODES.persistenceFailed,
      projection_error_sequence: '7', projection_error_generation: '3', projection_error_phase: 'persist', projection_error_permanent: permanent };
    const state = await mapValidatedNativeStateRow(raw, 'row-doc'); assert(state);
    assert.equal(state.degraded, true); assert.equal(state.projectionError?.code, COLLABORATION_FAILURE_CODES.persistenceFailed);
    assert.equal(state.projectionError?.permanent, permanent === 1 || permanent === '1');
    assert.equal(isCollaborationStateQuarantined(state), permanent === 1 || permanent === '1');
    if (isCollaborationStateQuarantined(state)) assert.throws(() => authoritativeNativeCollaborationSnapshot(state), /quarantined/u);
    else assert.equal(authoritativeNativeCollaborationSnapshot(state).documentId, 'row-doc');
  }
});

test('malformed or unbound raw flags/errors fail before the general mapper can omit them', async () => {
  const raw = row();
  for (const change of [{ has_bom: 2 }, { has_bom: 'false' }, { degraded: 2 }, { degraded: null },
    { projection_error_permanent: 2 }, { projection_error_permanent: true }, { projection_error_permanent: '1' },
    { projection_error_permanent: '1', projection_error_code: 'failure', projection_error_sequence: '7', projection_error_generation: '2' },
    { projection_error_code: 'failure', projection_error_sequence: '8', projection_error_generation: '3' },
    { projection_error_code: 'failure', projection_error_sequence: '7', projection_error_generation: '3', projection_error_phase: 'bad\0phase' },
    { status: 'archived' }]) {
    await assert.rejects(mapValidatedNativeStateRow({ ...raw, ...change }, 'row-doc'),
      error => error instanceof NativeSessionStateReaderError && error.code === 'NATIVE_SESSION_STATE_INVALID');
  }
});
