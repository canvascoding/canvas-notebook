import 'server-only';

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FileVersionCenterDatabase } from '../app/lib/file-version-center/database';
import { readProposalEntryPoint } from '../app/lib/file-version-center/proposal-entrypoint-service';
import type { FileVersionCenterAccess, ResolvedFileVersionTarget } from '../app/lib/file-version-center/query-service';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import { proposalScopeFixture } from './fixtures/proposal-graph-contract-v1';

const target: ResolvedFileVersionTarget = {
  workspaceId: proposalScopeFixture.workspaceId,
  lineageId: proposalScopeFixture.lineageId,
  documentId: proposalScopeFixture.documentId,
  path: 'private-path.md',
  latestRevisionId: null,
  latestRevisionHash: null,
  latestRevisionSize: 0,
};
const workspace: WorkspaceContext = {
  workspaceId: target.workspaceId, workspaceType: 'team', rootPath: '/unused', organizationId: 'org',
  legacy: false, permissions: { canRead: true, canWrite: true, canDelete: false,
    canCreatePublicLinks: false, canManageWorkspace: false, canRunAgent: true },
};
const access: FileVersionCenterAccess = {
  userId: 'reviewer', authenticatedWorkspaceId: target.workspaceId, requestedWorkspaceId: target.workspaceId,
  membership: 'active', permissionsResolved: true, canRead: true, canWrite: true, canManageWorkspace: false,
};

type QueryCapture = { sql: string; values: unknown[] };
type EntryPointRows = { graphRevision?: number; successors?: Array<Record<string, unknown>>; graphMissing?: boolean };

function database(options: EntryPointRows = {}, captures: QueryCapture[] = []): FileVersionCenterDatabase {
  return { transaction: async action => action({ query: async <Row>(sql: string, values: unknown[] = []) => {
    captures.push({ sql, values });
    if (sql.includes('SELECT graph.graph_id')) {
      return { rows: options.graphMissing ? [] : [{ graph_id: 'graph-auth', graph_revision: options.graphRevision ?? 9 }] as Row[] };
    }
    if (sql.includes('SELECT successor.proposal_id')) {
      return { rows: (options.successors ?? []) as Row[] };
    }
    throw new Error(`Unexpected SQL: ${sql.slice(0, 70)}`);
  } } as never) };
}

function proposal(lifecycle = 'open') {
  return { proposalId: 'proposal-original', operationId: 'operation-old',
    rootProposalId: 'proposal-root', lifecycle };
}

function readEntryPoint(summaryItem: Record<string, unknown>, options: {
  graphRevision?: number | null;
  graphRows?: EntryPointRows;
  captures?: QueryCapture[];
  access?: FileVersionCenterAccess;
  workspace?: WorkspaceContext;
  operationId?: string;
} = {}) {
  return readProposalEntryPoint({ workspace: options.workspace ?? workspace, access: options.access ?? access,
    lineageId: target.lineageId, operationId: options.operationId ?? 'operation-old' }, {
    resolve: async () => target,
    summary: async () => ({ graphRevision: options.graphRevision === undefined ? 9 : options.graphRevision,
      items: [summaryItem] }) as never,
    database: database(options.graphRows, options.captures),
  } as never);
}

test('an exact historical operation keeps its proposal lifecycle instead of stale legacy review status', async () => {
  for (const lifecycle of ['included', 'superseded', 'rejected'] as const) {
    const captures: QueryCapture[] = [];
    const result = await readEntryPoint({ mode: 'graph', operationId: 'operation-old',
      proposal: proposal(lifecycle), status: 'clean' }, { captures });
    assert.equal(result?.proposalId, 'proposal-original');
    assert.equal(result?.lifecycle, lifecycle);
    assert.equal(result?.status, 'clean');
    assert.equal(captures[0]?.values[3], 'operation-old', 'the annotation remains bound to the stored operation ID');
  }
});

test('fresh conflict, blocked parent, and lost prerequisite remain distinguishable', async () => {
  const conflicted = await readEntryPoint({ mode: 'graph', operationId: 'operation-old',
    proposal: proposal(), status: 'conflicted' });
  assert.equal(conflicted?.lifecycle, 'open');
  assert.equal(conflicted?.status, 'conflicted');

  const blocked = await readEntryPoint({ mode: 'graph', operationId: 'operation-old',
    proposal: proposal(), status: 'blocked_by_parent' });
  assert.equal(blocked?.status, 'blocked_by_parent');

  const prerequisiteLost = await readEntryPoint({ mode: 'graph', operationId: 'operation-old',
    proposal: proposal(), status: 'prerequisite_lost' });
  assert.equal(prerequisiteLost?.status, 'prerequisite_lost');
});

test('legacy or absent operation has no graph annotation and never selects another proposal', async () => {
  const legacy = await readEntryPoint({ mode: 'legacy', operationId: 'operation-old' });
  assert.equal(legacy, null);
  const absent = await readEntryPoint({ mode: 'graph', operationId: 'operation-other', proposal: proposal() },
    { operationId: 'operation-old' });
  assert.equal(absent, null);
});

test('entrypoint lookup fails closed when graph proof is missing or the annotation is unavailable', async () => {
  await assert.rejects(readEntryPoint({ mode: 'graph', operationId: 'operation-old',
    proposal: null, reasonCode: 'PROPOSAL_CONTENT_UNAVAILABLE' }), /context is unavailable/u);
  await assert.rejects(readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal() },
    { graphRevision: null }), /context is unavailable/u);
  await assert.rejects(readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal() },
    { graphRows: { graphMissing: true } }), /graph changed/u);
});

test('successors are bounded and authorized in SQL by workspace, document, original graph, and actor/manage scope', async () => {
  const successors = Array.from({ length: 34 }, (_, index) => ({
    proposal_id: `proposal-next-${index}`,
    operation_id: `operation-next-${index}`,
    lifecycle: 'open',
    relation: index % 2 ? 'extends' : 'replaces',
  }));
  const captures: QueryCapture[] = [];
  const result = await readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal(), status: 'clean' },
    { graphRows: { successors }, captures });

  assert.equal(result?.successors.length, 32);
  assert.equal(result?.moreSuccessors, true);
  assert.equal(result?.successors[0]?.proposalId, 'proposal-next-0');
  assert.equal(result?.successors[31]?.proposalId, 'proposal-next-31');
  assert.ok(!result?.successors.some(successor => successor.proposalId === 'proposal-next-32'),
    'overflow is indicated instead of silently choosing a latest successor');
  assert.equal(captures.length, 2);
  assert.match(captures[0]!.sql, /graph\.workspace_id=\$1 AND graph\.lineage_id=\$2 AND graph\.document_id=\$3/u);
  assert.match(captures[0]!.sql, /original\.operation_id=\$4/u);
  assert.match(captures[0]!.sql, /original\.proposal_id=\$5/u);
  assert.match(captures[0]!.sql, /state\.lifecycle_generation=graph\.lifecycle_generation/u);
  assert.match(captures[0]!.sql, /state\.schema_version=graph\.schema_version/u);
  assert.deepEqual(captures[0]!.values, [target.workspaceId, target.lineageId, target.documentId,
    'operation-old', 'proposal-original']);
  assert.match(captures[1]!.sql, /successor\.graph_id=\$1/u);
  assert.match(captures[1]!.sql, /operation\.workspace_id=\$3 AND operation\.document_id=\$4/u);
  assert.match(captures[1]!.sql, /operation\.initiated_by_user_id=\$5 OR \$6::boolean/u);
  assert.match(captures[1]!.sql, /LIMIT 33/u);
  assert.deepEqual(captures[1]!.values, ['graph-auth', 'proposal-original', target.workspaceId,
    target.documentId, access.userId, false]);
});

test('manager successor authorization is an explicit scoped boolean, never inferred from arbitrary access', async () => {
  const captures: QueryCapture[] = [];
  const result = await readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal(), status: 'clean' },
    { access: { ...access, canManageWorkspace: true },
      workspace: { ...workspace, permissions: { ...workspace.permissions, canManageWorkspace: true } },
      graphRows: { successors: [{ proposal_id: 'proposal-next', operation_id: 'operation-next',
        lifecycle: 'open', relation: 'replaces' }] }, captures });
  assert.equal(result?.successors[0]?.proposalId, 'proposal-next');
  assert.equal(captures[1]!.values[5], true);

  const nonManagerCaptures: QueryCapture[] = [];
  await readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal(), status: 'clean' },
    { access: { ...access, canManageWorkspace: true }, workspace, captures: nonManagerCaptures });
  assert.equal(nonManagerCaptures[1]!.values[5], false,
    'an access hint cannot disclose other authors’ rows if the resolved workspace denies manage');
});

test('successors are rejected when the graph revision changed after the summary proof', async () => {
  const captures: QueryCapture[] = [];
  await assert.rejects(readEntryPoint({ mode: 'graph', operationId: 'operation-old', proposal: proposal(), status: 'clean' },
    { graphRows: { graphRevision: 10 }, captures }), /graph changed/u);
  assert.equal(captures.length, 1, 'successor identities are not queried after a stale graph revision');
});
