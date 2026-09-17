import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';

import type * as Agent from '../app/lib/collaboration/agent-operations';
import type { FileVersionCenterTransaction } from '../app/lib/file-version-center/database';
import { ProposalGraphContractError } from '../app/lib/file-version-center/contracts/proposal-graph-v1';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const workspace: WorkspaceContext = { workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization',
  rootPath: '/unused', legacy: false, permissions: { canRead: true, canWrite: true, canRunAgent: true,
    canDelete: false, canCreatePublicLinks: false, canManageWorkspace: false } };
type Row = Record<string, unknown> & { operation_id: string; cas_version: number; status: string };

/** Real operation statements executed against a rollback-capable, narrow SQL adapter. */
function operationBridgeHarness() {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'proposal-bridge-unit-test-secret-not-for-production';
  const doc = new Y.Doc();
  doc.getText('content').insert(0, 'Original');
  const state = { documentId: 'document', workspaceId: 'workspace', organizationId: 'organization',
    path: 'document.txt', representation: 'plain_text', status: 'active', lifecycleGeneration: 1, schemaVersion: 1,
    degraded: false, documentSequence: 7, checkpointSequence: 7, persistedAt: Date.now(),
    yjsState: Y.encodeStateAsUpdate(doc), stateVector: Y.encodeStateVector(doc) };
  let rows = new Map<string, Row>();
  const sqlTrace: string[] = [];
  const forbiddenCalls: string[] = [];
  let transactionActive = false;
  let failReviewTransition = false;
  let loads = 0;
  const forbidden = (name: string) => () => {
    forbiddenCalls.push(name);
    throw new Error(`Review-only preparation must not call ${name}`);
  };
  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const mock = (name: string) => {
    if (name === '@/app/lib/db') return { openDb: forbidden('openDb') };
    if (name === './persistence') return { loadCollaborationState: async (id: string) => {
      assert.equal(id, state.documentId); loads++; return { ...state };
    } };
    if (name === './server-runtime') return { Y };
    if (name === '@/app/lib/file-version-center/agent-review-policy-adapter') return {
      authorizeNewAgentDirectApply: forbidden('authorizeNewAgentDirectApply'),
      readAgentReviewPolicySnapshot: forbidden('readAgentReviewPolicySnapshot'),
    };
    if (name === './direct-connection') return {
      AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: forbidden('runCollaborationDirectConnection'),
    };
    if (name === './agent-direct-edit-grants') return {
      AgentDirectEditGrantUnavailableError: class extends Error {},
      withAgentDirectEditGrant: forbidden('withAgentDirectEditGrant'),
    };
    if (name === './document-access') return { readCurrentCollaborationDocument: forbidden('readCurrentCollaborationDocument') };
    if (name === '@/app/lib/file-version-center/history-service') return {
      fileVersionHistoryService: { capturePersistedCollaboration: forbidden('capturePersistedCollaboration') },
    };
    if (name === './presence') return { upsertDocumentPresenceEntry: forbidden('upsertDocumentPresenceEntry'),
      removeDocumentPresenceEntry: forbidden('removeDocumentPresenceEntry') };
    if (name === './diagnostics') return { logCollaborationDiagnostic: () => {} };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: forbidden('recordAuditEvent') };
    return load(name);
  };
  new Function('require', 'module', 'exports', source)(mock, { exports }, exports);
  const agent = exports as typeof Agent;
  const target = agent.createAgentTextTarget({ text: doc.getText('content'), from: 0, to: 8,
    replacement: 'Proposed', targetId: 'target', groupId: 'group' });
  const query = async (sql: string, params: unknown[] = []) => {
    assert.equal(transactionActive, true, 'every statement belongs to the graph-owner transaction');
    sqlTrace.push(sql);
    assert.match(sql.trim(), /^(SELECT|INSERT|UPDATE)\b/u, 'preparation cannot commit or release the owner transaction');
    if (sql.includes('INSERT INTO collaboration_agent_operations')) {
      assert.match(sql, /RETURNING 1$/u, 'shared transaction returns rows, not a hidden rowCount');
      const insert = /\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/u.exec(sql)!;
      const columns = insert[1].split(',').map((value) => value.trim());
      const values = insert[2].split(',').map((value) => value.trim());
      const row: Record<string, unknown> = {};
      columns.forEach((column, index) => {
        const value = values[index];
        row[column] = value.startsWith('$') ? params[Number(value.slice(1)) - 1]
          : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1) : Number(value);
      });
      assert.equal(typeof row.operation_id, 'string');
      assert.equal(rows.has(String(row.operation_id)), false);
      rows.set(String(row.operation_id), row as Row);
      return [{ '?column?': 1 }];
    }
    if (sql.trim().startsWith('UPDATE ')) {
      assert.match(sql, /RETURNING 1$/u);
      if (failReviewTransition) throw new Error('Injected needs_review transition failure');
      const assignments = [.../SET ([\s\S]*?)\s+WHERE/u.exec(sql)![1].matchAll(/(\w+) = \$(\d+)/gu)];
      const count = assignments.length;
      const row = rows.get(String(params[count]));
      if (!row || row.cas_version !== params[count + 1] || row.run_generation !== params[count + 2]
        || !params.slice(count + 3).includes(row.status)) return [];
      for (const [, field, position] of assignments) row[field] = params[Number(position) - 1];
      row.cas_version++;
      return [{ '?column?': 1 }];
    }
    if (sql.includes('WHERE document_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3')) {
      return [...rows.values()].filter((row) => row.document_id === params[0]
        && row.initiated_by_user_id === params[1] && row.idempotency_key === params[2]).map((row) => ({ ...row }));
    }
    assert.ok(sql.includes('WHERE operation.operation_id = $1 LIMIT 1'), `Unexpected SQL: ${sql}`);
    const row = rows.get(String(params[0]));
    return row ? [{ ...row, initiated_by_display_name: 'Fixture user' }] : [];
  };
  const transaction: FileVersionCenterTransaction = {
    query: async <RowType>(sql: string, params?: unknown[]) => ({ rows: await query(sql, params) as RowType[] }),
  };
  const prepare = (operationId = 'reserved-operation', fingerprint = hash('request'), actualWorkspace = workspace) => agent.prepareProposalAgentOperation({
    transaction, operationId, documentId: 'document', workspace: actualWorkspace, initiatedByUserId: 'user',
    actorId: 'agent', actorSessionId: 'session', idempotencyKey: 'stable-operation-request', targets: [target],
    documentPath: 'document.txt', documentRepresentation: 'plain_text', documentLifecycleGeneration: 1, documentSchemaVersion: 1,
    baseStateVector: Buffer.from(state.stateVector).toString('base64'), baseDocumentSequence: 7,
    fileEditRequest: { fingerprint, beforeSha256: hash('Original'), proposedSha256: hash('Proposed') },
  });
  const atomic = async <T>(action: () => Promise<T>): Promise<T> => {
    const before = structuredClone(rows);
    assert.equal(transactionActive, false); transactionActive = true;
    try { return await action(); } catch (error) { rows = before; throw error; }
    finally { transactionActive = false; }
  };
  return { doc, state, rows: () => rows, sqlTrace, forbiddenCalls, loads: () => loads, prepare, atomic,
    failReviewTransition: () => { failReviewTransition = true; }, close: () => doc.destroy() };
}

test('graph operation bridge stores only a durable review operation and never obtains a direct grant', async () => {
  const h = operationBridgeHarness();
  try {
    const result = await h.atomic(() => h.prepare());
    assert.equal(result.operationId, 'reserved-operation');
    assert.equal(result.operationStatus, 'needs_review');
    assert.equal(result.status, 'needs_review');
    assert.equal(result.durability, 'needs_review');
    assert.equal(result.casVersion, 1);
    assert.deepEqual(result.appliedTargetIds, []);
    const row = h.rows().get(result.operationId)!;
    assert.equal(row.requested_mode, 'review');
    assert.equal(row.direct_edit_grant_id, null);
    assert.equal(row.expires_at, null);
    assert.equal(row.error_code, 'proposal_graph_review_required');
    assert.equal(row.document_lifecycle_generation, 1);
    assert.equal(row.schema_version, 1);
    assert.equal(row.document_path, 'document.txt');
    assert.equal(row.actor_session_id, 'session');
    assert.equal(row.base_document_sequence, 7);
    assert.equal(h.loads(), 1);
    assert.deepEqual(h.forbiddenCalls, []);
    assert.equal(h.doc.getText('content').toString(), 'Original');
  } finally { h.close(); }
});

test('operation insert rolls back if its review transition or subsequent graph insertion fails', async () => {
  for (const failTransition of [false, true]) {
    const h = operationBridgeHarness();
    try {
      if (failTransition) h.failReviewTransition();
      await assert.rejects(h.atomic(async () => {
        await h.prepare();
        throw new Error('Injected graph insertion failure');
      }), /Injected/u);
      assert.equal(h.rows().size, 0, 'there is no orphan legacy operation after rollback');
      assert.ok(h.sqlTrace.some((sql) => sql.includes('INSERT INTO collaboration_agent_operations')));
      assert.deepEqual(h.forbiddenCalls, []);
      assert.equal(h.doc.getText('content').toString(), 'Original');
    } finally { h.close(); }
  }
});

test('duplicate operation identity must be recovered by provenance, never rebound to a new graph proposal', async () => {
  const h = operationBridgeHarness();
  try {
    await h.atomic(() => h.prepare());
    for (const id of ['reserved-operation', 'new-operation']) {
      await assert.rejects(h.atomic(() => h.prepare(id)), (error: unknown) => error instanceof ProposalGraphContractError
        && error.code === 'PROPOSAL_IDEMPOTENCY_MISMATCH');
    }
    assert.equal(h.rows().size, 1);
    assert.equal(h.rows().get('reserved-operation')!.cas_version, 1);
    assert.equal(h.sqlTrace.filter((sql) => sql.includes('INSERT INTO collaboration_agent_operations')).length, 1);
    assert.deepEqual(h.forbiddenCalls, []);
  } finally { h.close(); }
});

test('duplicate key with changed request digest retains the stable graph conflict code', async () => {
  const h = operationBridgeHarness();
  try {
    await h.atomic(() => h.prepare());
    await assert.rejects(h.atomic(() => h.prepare('different-operation', hash('changed-request'))),
      (error: unknown) => error instanceof ProposalGraphContractError && error.code === 'PROPOSAL_IDEMPOTENCY_MISMATCH');
    assert.equal(h.rows().size, 1);
    assert.equal(h.rows().get('reserved-operation')!.cas_version, 1);
    assert.equal(h.sqlTrace.filter((sql) => sql.includes('INSERT INTO collaboration_agent_operations')).length, 1);
    assert.deepEqual(h.forbiddenCalls, []);
  } finally { h.close(); }
});

test('operation bridge rejects denied workspace and stale path before inserting anything', async () => {
  const h = operationBridgeHarness();
  try {
    await assert.rejects(h.atomic(() => h.prepare('operation', hash('request'), {
      ...workspace, permissions: { ...workspace.permissions, canWrite: false },
    })), (error: unknown) => error instanceof ProposalGraphContractError && error.code === 'PROPOSAL_ACCESS_DENIED');
    assert.equal(h.sqlTrace.length, 0);
    h.state.path = 'renamed.txt';
    await assert.rejects(h.atomic(() => h.prepare()), /unavailable or stale/u);
    assert.equal(h.rows().size, 0);
    assert.deepEqual(h.forbiddenCalls, []);
  } finally { h.close(); }
});
