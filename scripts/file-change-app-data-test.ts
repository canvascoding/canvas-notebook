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

  const graphGroup: FileChangeGroupV1 = {
    ...group,
    entries: [
      { id: 'entry-1', ordinal: 0, lineageId: 'lineage-1', operationId: 'operation-1',
        pathHint: 'docs/one.md', outcome: 'review_required' },
      { id: 'entry-2', ordinal: 1, lineageId: 'lineage-2', operationId: 'operation-2',
        pathHint: 'docs/two.md', outcome: 'review_required' },
      { id: 'entry-3', ordinal: 2, lineageId: 'lineage-3', operationId: 'operation-3',
        pathHint: 'docs/three.md', outcome: 'review_required' },
    ],
  };
  rows = graphGroup.entries.map((entry) => ({ entry_id: entry.id, operation_status: 'needs_review',
    proposal_id: `proposal-${entry.ordinal}`, latest_revision_id: null, latest_revision_source: null }));
  const lifecycles = ['included', 'superseded', 'rejected'] as const;
  data = await presentFileChangeAppData(graphGroup, database, {
    access: { userId: 'reviewer', canManageWorkspace: false } as never,
    workspace: {} as never,
    readEntryPoint: (async ({ operationId }: { operationId: string }) => {
      const ordinal = Number(operationId.slice('operation-'.length)) - 1;
      const lifecycle = lifecycles[ordinal]!;
      return { contractVersion: 1, proposalId: `proposal-${ordinal}`, rootProposalId: `proposal-${ordinal}`,
        lineageId: `lineage-${ordinal + 1}`, graphRevision: 7, lifecycle, status: 'clean', successors: [],
        moreSuccessors: false };
    }) as never,
  });
  assert.deepEqual(data.entries.map((entry) => entry.state), ['included', 'superseded', 'rejected'],
    'graph lifecycle annotations override stale needs_review operation metadata');
  assert.deepEqual(data.entries.map((entry) => entry.operationId), ['operation-1', 'operation-2', 'operation-3'],
    'the stored historical operation reference remains exact');

  rows = [{ entry_id: 'entry-1', operation_status: 'needs_review', proposal_id: 'proposal-1',
    latest_revision_id: null, latest_revision_source: null }];
  const oneGraphEntry = { ...graphGroup, entries: [graphGroup.entries[0]!] };
  const annotation = (status: string) => ({ contractVersion: 1 as const, proposalId: 'proposal-0',
    rootProposalId: 'proposal-0', lineageId: 'lineage-1', graphRevision: 7,
    lifecycle: 'open' as const, status, successors: [], moreSuccessors: false });
  const graphReview = { access: {} as never, workspace: {} as never,
    readEntryPoint: async () => annotation('conflicted') as never };
  data = await presentFileChangeAppData(oneGraphEntry, database, graphReview as never);
  assert.equal(data.entries[0]?.state, 'conflict');

  const blockedStatuses = ['blocked_by_parent', 'prerequisite_lost'];
  for (const status of blockedStatuses) {
    data = await presentFileChangeAppData(oneGraphEntry, database, {
      ...graphReview, readEntryPoint: async () => annotation(status) as never,
    } as never);
    assert.equal(data.entries[0]?.state, 'blocked_by_parent', `${status} must not reappear as an active review prompt`);
  }

  data = await presentFileChangeAppData(oneGraphEntry, database, {
    ...graphReview, readEntryPoint: async () => { throw new Error('authorization or proof unavailable'); },
  } as never);
  assert.equal(data.entries[0]?.state, 'unavailable', 'annotation failure must fail closed, not expose stale needs_review');
  data = await presentFileChangeAppData(oneGraphEntry, database, {
    ...graphReview, readEntryPoint: async () => null,
  } as never);
  assert.equal(data.entries[0]?.state, 'unavailable', 'a graph-known operation without annotation fails closed');
  console.log('File-change widget refresh data follows operation and revision state');
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
