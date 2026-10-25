import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { buildCollaborationRecoveryEvidence, type RecoveryRows } from '../app/lib/collaboration/recovery-evidence';
import { recoveryHash } from '../app/lib/collaboration/recovery-plan';
import { prepareCollaborationRecoverySelection, type RecoveryBundle } from '../app/lib/collaboration/recovery-operator';

function fixture(): RecoveryBundle {
  const canonical = 'Verified content.\n', serialized = '\uFEFFVerified content.\r\n';
  const doc = new Y.Doc(); doc.getText('content').insert(0, canonical);
  try {
    const scope = { workspace_id: 'workspace', organization_id: 'organization', customer_id: null, project_id: null,
      workspace_type: 'team', path: 'note.txt' };
    const rows: RecoveryRows = {
      states: [{ document_id: 'historical-source', ...scope, representation: 'plain_text', lifecycle_generation: '1', schema_version: '1',
        yjs_state: Y.encodeStateAsUpdate(doc), state_vector: Y.encodeStateVector(doc), document_sequence: '5', checkpoint_sequence: '5',
        persisted_at: '1', checkpointed_at: '1', canonical_hash: recoveryHash(canonical), serialized_hash: recoveryHash(serialized),
        newline_style: 'crlf', has_bom: '1', degraded: '0', status: 'active', room_owner_epoch: '0',
        room_owner_token: null, room_owner_backend_pid: null, room_owner_backend_start: null }],
      registry: [{ id: 'current-successor', ...scope, lineage_id: 'current-lineage', provider: 'yjs', state_version: '0',
        snapshot_revision_id: 'current-revision', yjs_state_lifecycle: 'legacy_unknown', status: 'active', created_at: '2', updated_at: '2' }],
      revisions: [{ id: 'current-revision', ...scope, lineage_id: 'current-lineage', revision_number: '1', history_only: false,
        content_hash: recoveryHash(serialized), size_bytes: String(Buffer.byteLength(serialized)), created_at: '2' }],
      workspaces: [{ id: 'workspace', organization_id: 'organization', customer_id: null, project_id: null,
        type: 'team', status: 'active', root_relative_path: 'workspaces/team/organization/recovery/files' }], receipts: [],
    };
    const evidence = buildCollaborationRecoveryEvidence(rows);
    evidence.files.push({ workspaceId: 'workspace', path: 'note.txt', hash: recoveryHash(serialized), errorCode: null });
    return { manifestHash: recoveryHash('isolated test evidence'), rows, evidence, historicalIdentities: [] };
  } finally { doc.destroy(); }
}

test('missing-successor proposal retains the current ID and requires exact verified content without mutating evidence', () => {
  const bundle = fixture(), before = structuredClone(bundle);
  const first = prepareCollaborationRecoverySelection(bundle), second = prepareCollaborationRecoverySelection(bundle);
  assert.deepEqual(first, second); assert.deepEqual(bundle, before);
  assert.equal(first.operations.length, 1); assert.equal(first.manual.length, 0);
  const operation = first.operations[0];
  assert.equal(operation.kind, 'seed_missing_successor'); assert.equal(operation.selected, false);
  assert.equal(operation.expectedRegistry?.id, 'current-successor');
  assert.equal(operation.expectedState.document_id, 'historical-source');
  assert.equal(operation.expectedFileHash, operation.projectedFileHash);
});

const rejected: Array<[string, (bundle: RecoveryBundle) => void]> = [
  ['initialized successor', bundle => { bundle.rows.registry[0].yjs_state_lifecycle = 'initialized'; }],
  ['advanced successor', bundle => { bundle.rows.registry[0].state_version = '1'; }],
  ['foreign registry scope', bundle => { bundle.rows.registry[0].organization_id = 'foreign'; }],
  ['foreign customer', bundle => { bundle.rows.registry[0].customer_id = 'foreign'; }],
  ['foreign lineage', bundle => { bundle.rows.registry[0].lineage_id = 'foreign'; }],
  ['unknown revision', bundle => { bundle.rows.revisions = []; }],
  ['different revision bytes', bundle => { bundle.rows.revisions[0].content_hash = recoveryHash('other'); }],
  ['different revision size', bundle => { bundle.rows.revisions[0].size_bytes = '1'; }],
  ['history-only revision', bundle => { bundle.rows.revisions[0].history_only = true; }],
  ['foreign revision scope', bundle => { bundle.rows.revisions[0].project_id = 'foreign'; }],
  ['quarantined source', bundle => { bundle.rows.states[0].degraded = '1'; }],
  ['uncheckpointed source', bundle => { bundle.rows.states[0].checkpoint_sequence = '4'; }],
  ['wrong canonical hash', bundle => { bundle.rows.states[0].canonical_hash = recoveryHash('other'); }],
  ['wrong state vector', bundle => { bundle.rows.states[0].state_vector = new Uint8Array([0]); }],
  ['disabled workspace', bundle => { bundle.rows.workspaces[0].status = 'disabled'; }],
  ['different physical bytes', bundle => { bundle.evidence.files[0].hash = recoveryHash('other'); }],
];
for (const [name, change] of rejected) test(`missing-successor proposal rejects ${name}`, () => {
  const bundle = fixture(); change(bundle);
  assert(!prepareCollaborationRecoverySelection(bundle).operations.some(operation => operation.kind === 'seed_missing_successor'));
});
