import assert from 'node:assert/strict';

import type { FileChangeGroupV1 } from '../app/lib/file-version-center/contracts/v1';
import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { presentFileChangeAppData } from '../app/lib/tool-apps/file-change-service';

const group: FileChangeGroupV1 = {
  contractVersion: 1,
  id: `fvcg-${'b'.repeat(64)}`,
  workspaceId: 'workspace-1',
  sourceSessionId: 'session-1',
  toolCallId: 'call-1',
  operation: 'apply_patch',
  status: 'mixed',
  createdAt: '2026-09-14T10:00:00.000Z',
  entries: [
    { id: 'entry-1', ordinal: 0, lineageId: 'lineage-1', operationId: 'operation-1',
      pathHint: 'docs/one.md', outcome: 'review_required' },
    { id: 'entry-2', ordinal: 1, lineageId: 'lineage-2', revisionId: 'revision-2',
      pathHint: 'docs/two.md', outcome: 'applied', additions: 2, deletions: 1 },
  ],
};

let rows: Array<Record<string, string | null>> = [];
const database: FileVersionCenterDatabase = {
  transaction: async (action) => action({
    query: async <Row>() => ({ rows: rows as Row[] }),
  }),
};

async function main() {
  rows = [
    { entry_id: 'entry-1', operation_status: 'needs_review', latest_revision_id: null, latest_revision_source: null },
    { entry_id: 'entry-2', operation_status: null, latest_revision_id: 'revision-2', latest_revision_source: 'agent_apply' },
  ];
  let data = await presentFileChangeAppData(group, database);
  assert.equal(data.status, 'mixed');
  assert.deepEqual(data.entries.map((entry) => entry.state), ['review_required', 'applied']);

  rows = [
    { entry_id: 'entry-1', operation_status: 'rejected', latest_revision_id: null, latest_revision_source: null },
    { entry_id: 'entry-2', operation_status: null, latest_revision_id: 'revision-restored', latest_revision_source: 'restore' },
  ];
  data = await presentFileChangeAppData(group, database);
  assert.deepEqual(data.entries.map((entry) => entry.state), ['rejected', 'restored']);

  rows = [
    { entry_id: 'entry-1', operation_status: 'reverted', latest_revision_id: null, latest_revision_source: null },
    { entry_id: 'entry-2', operation_status: null, latest_revision_id: 'revision-newer', latest_revision_source: 'manual' },
  ];
  data = await presentFileChangeAppData(group, database);
  assert.deepEqual(data.entries.map((entry) => entry.state), ['reverted', 'superseded']);
  console.log('File-change widget refresh data follows operation and revision state');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
