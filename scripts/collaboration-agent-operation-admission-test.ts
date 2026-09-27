import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';
import * as Y from 'yjs';

import type * as Agent from '../app/lib/collaboration/agent-operations';
import { executeLifecycleTransaction } from '../app/lib/collaboration/lifecycle-transaction';
import { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace } from '../app/lib/collaboration/room-admission';
import { captureCollaborationAdmissionWriterScope, CollaborationAdmissionError } from '../app/lib/collaboration/room-admission-contract';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';

type Row = Record<string, unknown> & {
  operation_id: string;
  document_id: string;
  workspace_id: string;
  status: string;
  cas_version: number;
};
type AdmittedInput = Omit<Parameters<typeof Agent.applyPersistedAgentTextOperation>[0], 'actorDisplayName'> & {
  independentGroups: boolean;
  requestedMode: 'direct_apply' | 'review';
  operationType: 'apply' | 'revert';
};
type Internals = typeof Agent & {
  createOrLoadAdmittedOperation(input: AdmittedInput): Promise<{ row: Row; created: boolean }>;
};

const workspace: WorkspaceContext = {
  workspaceId: 'workspace', workspaceType: 'organization', organizationId: 'organization', rootPath: '/unused', legacy: false,
  permissions: { canRead: true, canWrite: true, canRunAgent: true, canDelete: false,
    canCreatePublicLinks: false, canManageWorkspace: false },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

function cloneRows(rows: Map<string, Row>): Map<string, Row> {
  return new Map([...rows].map(([key, row]) => [key, structuredClone(row)]));
}

function harness() {
  process.env.CANVAS_COLLABORATION_TICKET_SECRET = 'operation-admission-unit-secret-32-characters';
  const document = new Y.Doc();
  document.getText('content').insert(0, 'Original');
  const state = {
    documentId: 'document', workspaceId: workspace.workspaceId, organizationId: workspace.organizationId,
    path: 'document.md', representation: 'plain_text' as const, status: 'active' as const,
    lifecycleGeneration: 1, schemaVersion: 1, degraded: false, documentSequence: 7, checkpointSequence: 7,
    persistedAt: Date.now(), yjsState: Y.encodeStateAsUpdate(document), stateVector: Y.encodeStateVector(document),
  };
  let committedRows = new Map<string, Row>();
  let nextConnectionId = 0;
  let openConnections = 0;
  let peakConnections = 0;
  let insertAttempts = 0;
  let admissionChecks = 0;
  let stateLoads = 0;
  let recoveryReads = 0;
  let reservationActive = false;
  let commitFault: 'none' | 'reject' | 'lost' = 'none';
  let failDiscard = false;
  let mutateAfterLostCommit: ((rows: Map<string, Row>) => void) | undefined;
  let pauseInsert = false;
  const insertEntered = deferred();
  const releaseInsert = deferred();
  const events: string[] = [];
  let workspaceLockOwner: number | null = null;
  const workspaceWaiters: Array<{ id: number; resolve: () => void }> = [];

  const acquireWorkspace = async (id: number) => {
    if (workspaceLockOwner === null) { workspaceLockOwner = id; return; }
    await new Promise<void>((resolve) => workspaceWaiters.push({ id, resolve }));
  };
  const releaseWorkspace = (id: number) => {
    if (workspaceLockOwner !== id) return;
    const next = workspaceWaiters.shift();
    if (next) { workspaceLockOwner = next.id; next.resolve(); } else workspaceLockOwner = null;
  };
  const reserve = async () => {
    const id = ++nextConnectionId;
    await acquireWorkspace(id);
    try {
      reservationActive = true;
      return [...committedRows.values()].filter((row) => row.status === 'preparing').map((row) => row.operation_id);
    } finally { releaseWorkspace(id); }
  };

  const openDb = async (): Promise<SqlConnection> => {
    const id = ++nextConnectionId;
    openConnections++;
    peakConnections = Math.max(peakConnections, openConnections);
    events.push(`open:${id}`);
    let released = false;
    let transactionRows: Map<string, Row> | null = null;
    let ownsWorkspace = false;
    const rows = () => transactionRows ?? committedRows;
    const lookup = (sql: string, params: unknown[]) => {
      if (sql.includes('WHERE document_id = $1 AND initiated_by_user_id = $2 AND idempotency_key = $3')) {
        return [...rows().values()].find((row) => row.document_id === params[0]
          && row.initiated_by_user_id === params[1] && row.idempotency_key === params[2]);
      }
      if (sql.includes('WHERE document_id = $1') && sql.includes('correlation_id = $3')) {
        return [...rows().values()].find((row) => row.document_id === params[0]
          && row.initiated_by_user_id === params[1] && row.correlation_id === params[2]
          && row.payload_hash === params[3] && row.operation_type === params[4]);
      }
      if (sql.includes('WHERE operation.operation_id = $1 LIMIT 1')) return rows().get(String(params[0]));
      return undefined;
    };
    const connection: SqlConnection = {
      async get(sql, params = []) {
        assert(!released, 'queries cannot use a closed connection');
        if (sql.includes('FROM collaboration_yjs_states')) {
          stateLoads++;
          assert(transactionRows, 'state must be loaded on the admitted transaction connection');
          assert.match(sql, /FOR SHARE\s*$/u, 'legacy admission must hold a state-row share lock until commit');
          return { ...state };
        }
        if (sql.includes('FROM file_change_proposals')) return undefined;
        if (!transactionRows) recoveryReads++;
        const row = lookup(sql, params);
        return row ? structuredClone(row) : undefined;
      },
      async all(sql, params = []) {
        assert(!released, 'queries cannot use a closed connection');
        if (sql.includes('pg_advisory_xact_lock')) {
          await acquireWorkspace(id); ownsWorkspace = true; events.push(`lock:${id}`); return [];
        }
        if (sql.includes('collaboration_admission_scopes')) {
          admissionChecks++;
          return reservationActive ? [{ request_id: 'reserved' }] : [];
        }
        if (sql.includes('collaboration_admission_targets')) {
          admissionChecks++;
          return reservationActive && params[0] === state.documentId ? [{ request_id: 'reserved' }] : [];
        }
        throw new Error(`Unexpected all SQL: ${sql}`);
      },
      async run(sql, params = []) {
        assert(!released, 'queries cannot use a closed connection');
        const normalized = sql.trim();
        if (normalized === 'BEGIN') { transactionRows = cloneRows(committedRows); events.push(`begin:${id}`); return { changes: 0 }; }
        if (normalized.startsWith('SET LOCAL')) return { changes: 0 };
        if (normalized === 'ROLLBACK') {
          transactionRows = null; releaseWorkspace(id); ownsWorkspace = false; events.push(`rollback:${id}`); return { changes: 0 };
        }
        if (normalized === 'COMMIT') {
          if (commitFault === 'reject') { commitFault = 'none'; events.push(`commit-reject:${id}`); throw new Error('EXPECTED_COMMIT_REJECTED'); }
          committedRows = cloneRows(transactionRows!);
          transactionRows = null; releaseWorkspace(id); ownsWorkspace = false;
          if (commitFault === 'lost') {
            commitFault = 'none'; mutateAfterLostCommit?.(committedRows); events.push(`commit-lost:${id}`);
            throw new Error('EXPECTED_COMMIT_RESPONSE_LOST');
          }
          events.push(`commit:${id}`); return { changes: 0 };
        }
        if (sql.includes('INSERT INTO collaboration_agent_operations')) {
          assert(transactionRows, 'operation insert requires the short transaction');
          insertAttempts++;
          if (pauseInsert) { insertEntered.resolve(); await releaseInsert.promise; }
          const insert = /\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/u.exec(sql)!;
          const columns = insert[1].split(',').map((value) => value.trim());
          const values = insert[2].split(',').map((value) => value.trim());
          const row: Record<string, unknown> = {};
          values.forEach((value, index) => {
            row[columns[index]!] = value.startsWith('$') ? params[Number(value.slice(1)) - 1]
              : value === 'NULL' ? null : value.startsWith("'") ? value.slice(1, -1) : Number(value);
          });
          transactionRows.set(String(row.operation_id), row as Row);
          return { changes: 1 };
        }
        throw new Error(`Unexpected run SQL: ${sql}`);
      },
      async close(error) {
        assert(!released, 'a connection closes once');
        released = true;
        if (ownsWorkspace) releaseWorkspace(id);
        openConnections--;
        events.push(`close:${id}:${error ? 'discard' : 'release'}`);
        if (error && failDiscard) throw new Error('EXPECTED_DISCARD_FAILURE');
      },
    };
    return connection;
  };

  const filename = path.resolve('app/lib/collaboration/agent-operations.ts');
  const load = createRequire(filename);
  const source = ts.transpileModule(`${readFileSync(filename, 'utf8')}\nexport { createOrLoadAdmittedOperation };`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const compiledExports = {};
  const mock = (name: string) => {
    if (name === '@/app/lib/db') return { openDb };
    if (name === './persistence') return {
      loadCollaborationState: async () => ({ ...state }),
      loadCollaborationStateOnConnection: async (database: SqlConnection, documentId: string,
        includeArchived = false, lock?: 'share') => {
        assert.equal(documentId, state.documentId);
        assert.equal(includeArchived, false);
        assert.equal(lock, 'share', 'legacy admission must request the shared state-row lock');
        return await database.get(`SELECT * FROM collaboration_yjs_states WHERE document_id = $1${lock === 'share' ? ' FOR SHARE' : ''}`,
          [documentId]);
      },
    };
    if (name === './lifecycle-transaction') return { executeLifecycleTransaction };
    if (name === './room-admission') return { assertCollaborationAdmissionOpen, lockCollaborationAdmissionWorkspace };
    if (name === './room-admission-contract') return { captureCollaborationAdmissionWriterScope, CollaborationAdmissionError };
    if (name === './server-runtime') return { Y };
    if (name === '@/app/lib/file-version-center/history-service') return {
      fileVersionHistoryService: { capturePersistedCollaboration: async () => null },
    };
    if (name === '@/app/lib/file-version-center/agent-review-policy-adapter') return {
      readAgentReviewPolicySnapshot: async () => { throw new Error('not used'); },
      authorizeNewAgentDirectApply: async () => { throw new Error('not used'); },
    };
    if (name === './direct-connection') return {
      AgentDirectConnectionAuthorizationError: class extends Error {},
      runCollaborationDirectConnection: async () => { throw new Error('not used'); },
    };
    if (name === './agent-direct-edit-grants') return {
      AgentDirectEditGrantUnavailableError: class extends Error {},
      withAgentDirectEditGrant: async () => { throw new Error('not used'); },
    };
    if (name === './document-access') return {
      readCurrentCollaborationDocument: async () => { throw new Error('not used'); },
    };
    if (name === './presence') return { upsertDocumentPresenceEntry() {}, removeDocumentPresenceEntry() {} };
    if (name === './diagnostics') return { logCollaborationDiagnostic() {} };
    if (name === '@/app/lib/audit/audit-service') return { recordAuditEvent: async () => {} };
    return load(name);
  };
  new Function('require', 'module', 'exports', source)(mock, { exports: compiledExports }, compiledExports);
  const agent = compiledExports as Internals;
  const target = agent.createAgentTextTarget({ text: document.getText('content'), from: 0, to: 8,
    replacement: 'Revised', targetId: 'target', groupId: 'group' });
  const input: AdmittedInput = {
    documentId: state.documentId, workspace, initiatedByUserId: 'user', actorId: 'agent', actorSessionId: 'session',
    idempotencyKey: 'delivery', runGeneration: 1, targets: [target], independentGroups: false,
    requestedMode: 'direct_apply', operationType: 'apply', documentPath: state.path,
    documentRepresentation: state.representation, documentLifecycleGeneration: state.lifecycleGeneration,
    documentSchemaVersion: state.schemaVersion,
  };
  const create = (overrides: Partial<AdmittedInput> = {}) => agent.createOrLoadAdmittedOperation({ ...input, ...overrides });
  return {
    create, reserve, input, state,
    setReserved(value: boolean) { reservationActive = value; },
    setCommitFault(value: typeof commitFault) { commitFault = value; },
    setFailDiscard(value: boolean) { failDiscard = value; },
    mutateAfterLostCommit(value: typeof mutateAfterLostCommit) { mutateAfterLostCommit = value; },
    pauseInsert() { pauseInsert = true; }, releaseInsert: releaseInsert.resolve, insertEntered: insertEntered.promise,
    rows: () => cloneRows(committedRows),
    stats: () => ({ openConnections, peakConnections, insertAttempts, admissionChecks, stateLoads, recoveryReads,
      waiters: workspaceWaiters.length }),
    events,
    close() { releaseInsert.resolve(); document.destroy(); },
  };
}

test('reserve-first rejects a new legacy operation without inserting or leaking a connection', async () => {
  const h = harness();
  try {
    h.setReserved(true);
    await assert.rejects(h.create(), (error: unknown) => error instanceof CollaborationAdmissionError
      && error.code === 'ADMISSION_CONFLICT');
    assert.equal(h.rows().size, 0);
    assert.deepEqual(h.stats(), { openConnections: 0, peakConnections: 1, insertAttempts: 0,
      admissionChecks: 2, stateLoads: 1, recoveryReads: 0, waiters: 0 });
  } finally { h.close(); }
});

test('admit-first commits one pending operation before a competing reservation proceeds', async () => {
  const h = harness();
  h.pauseInsert();
  const creation = h.create().then(
    (value) => ({ value, error: null as unknown }),
    (error: unknown) => ({ value: null, error }),
  );
  let reservation: Promise<{ value: string[] | null; error: unknown }> | undefined;
  try {
    await within(h.insertEntered, 'operation never reached the guarded insert');
    let reservationFinished = false;
    reservation = h.reserve().then(
      (value) => { reservationFinished = true; return { value, error: null as unknown }; },
      (error: unknown) => { reservationFinished = true; return { value: null, error }; },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(reservationFinished, false, 'reservation waits for the operation admission transaction');
    assert.equal(h.stats().waiters, 1);
    h.releaseInsert();
    const [created, pendingIds] = await within(Promise.all([creation, reservation]), 'admit-first operations did not settle');
    assert.ifError(created.error);
    assert.ifError(pendingIds.error);
    assert.equal(created.value!.created, true);
    assert.deepEqual(pendingIds.value, [created.value!.row.operation_id]);
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().openConnections, 0);
    assert.equal(h.stats().peakConnections, 1, 'state validation never nests another pool borrow');
  } finally {
    h.releaseInsert();
    await Promise.allSettled([creation, ...(reservation ? [reservation] : [])]);
    h.close();
  }
});

test('an exact existing retry remains readable under reservation and never rechecks new-insert admission', async () => {
  const h = harness();
  try {
    const first = await h.create();
    const checks = h.stats().admissionChecks;
    h.setReserved(true);
    const retry = await h.create();
    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.row.operation_id, first.row.operation_id);
    assert.equal(h.stats().admissionChecks, checks, 'existing retry exits before the new-insert admission assertion');
    assert.equal(h.stats().insertAttempts, 1);
    assert.equal(h.rows().size, 1);
  } finally { h.close(); }
});

test('a rejected COMMIT has no recovery proof and the same request can later create one row', async () => {
  const h = harness();
  try {
    h.setCommitFault('reject');
    await assert.rejects(h.create(), /EXPECTED_COMMIT_REJECTED/u);
    assert.equal(h.rows().size, 0);
    assert.equal(h.stats().insertAttempts, 1);
    assert.equal(h.stats().recoveryReads > 0, true, 'recovery performs only a fresh read');
    const retry = await h.create();
    assert.equal(retry.created, true);
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 2, 'only the explicit retry issues the second insert');
  } finally { h.close(); }
});

test('a committed-but-lost reply discards first and recovers the exact operation without a second insert', async () => {
  const h = harness();
  try {
    h.setCommitFault('lost');
    const recovered = await h.create();
    assert.equal(recovered.created, true);
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 1);
    assert.equal(h.stats().openConnections, 0);
    const lost = h.events.findIndex((event) => event.includes('commit-lost'));
    const discarded = h.events.findIndex((event) => event.includes('discard'));
    const recoveryOpen = h.events.findIndex((event, index) => index > discarded && event.startsWith('open:'));
    assert(lost >= 0 && discarded > lost && recoveryOpen > discarded, 'discard must precede recovery on a fresh connection');
  } finally { h.close(); }
});

test('lost-commit recovery rejects immutable payload or base-vector drift', async (t) => {
  for (const [label, mutate] of [
    ['operation payload', (row: Row) => { row.operation_payload = 'changed-payload'; }],
    ['base state vector', (row: Row) => { row.base_state_vector = Buffer.from([1, 2, 3]); }],
  ] as const) await t.test(label, async () => {
    const h = harness();
    try {
      h.setCommitFault('lost');
      h.mutateAfterLostCommit((rows) => mutate([...rows.values()][0]!));
      await assert.rejects(h.create(), (error: unknown) => error instanceof CollaborationAdmissionError
        && error.code === 'ADMISSION_SCOPE_CHANGED');
      assert.equal(h.rows().size, 1);
      assert.equal(h.stats().insertAttempts, 1);
    } finally { h.close(); }
  });
});

test('lost-commit recovery uses the immutable operation receipt rather than changed current state', async () => {
  const h = harness();
  try {
    h.setCommitFault('lost');
    h.mutateAfterLostCommit(() => {
      h.state.path = 'renamed-after-commit.md';
      h.state.lifecycleGeneration = 2;
    });
    const recovered = await h.create();
    assert.equal(recovered.created, true);
    assert.equal(h.stats().stateLoads, 1, 'recovery must not load changed current collaboration state');
    assert.equal(h.stats().recoveryReads > 0, true);
    assert.equal(h.rows().size, 1);
  } finally { h.close(); }
});

test('discard failure suppresses recovery while a later fresh retry still observes the single committed row', async () => {
  const h = harness();
  try {
    h.setCommitFault('lost');
    h.setFailDiscard(true);
    await assert.rejects(h.create(), (error: unknown) => error instanceof AggregateError
      && /could not be discarded/u.test(error.message));
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 1);
    assert.equal(h.stats().recoveryReads, 0, 'failed discard forbids opening a recovery reader');
    h.setFailDiscard(false);
    const retry = await h.create();
    assert.equal(retry.created, false);
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 1);
  } finally { h.close(); }
});

test('lost-commit recovery recognizes an already-advanced exact row without claiming it was newly created', async () => {
  const h = harness();
  try {
    h.setCommitFault('lost');
    h.mutateAfterLostCommit((rows) => {
      const row = [...rows.values()][0]!;
      row.status = 'needs_review';
      row.cas_version = 1;
      row.requested_mode = 'review';
    });
    const recovered = await h.create();
    assert.equal(recovered.created, false);
    assert.equal(recovered.row.status, 'needs_review');
    assert.equal(recovered.row.cas_version, 1);
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 1);
  } finally { h.close(); }
});

test('lost-commit recovery rejects an immutable operation identity change', async () => {
  const h = harness();
  try {
    h.setCommitFault('lost');
    h.mutateAfterLostCommit((rows) => {
      const row = [...rows.values()][0]!;
      row.operation_id = 'other-operation';
    });
    await assert.rejects(h.create(), (error: unknown) => error instanceof CollaborationAdmissionError
      && error.code === 'ADMISSION_SCOPE_CHANGED');
    assert.equal(h.rows().size, 1);
    assert.equal(h.stats().insertAttempts, 1);
  } finally { h.close(); }
});

test('new operation rejects organization, generation, or schema mismatch before insert', async (t) => {
  const cases: Array<[string, Partial<AdmittedInput>]> = [
    ['organization', { workspace: { ...workspace, organizationId: 'other-organization' } }],
    ['generation', { documentLifecycleGeneration: 2 }],
    ['schema', { documentSchemaVersion: 2 }],
  ];
  for (const [label, override] of cases) await t.test(label, async () => {
    const h = harness();
    try {
      await assert.rejects(h.create(override), (error: unknown) => error instanceof CollaborationAdmissionError
        && error.code === 'ADMISSION_SCOPE_CHANGED');
      assert.equal(h.rows().size, 0);
      assert.equal(h.stats().insertAttempts, 0);
      assert.equal(h.stats().admissionChecks, 0, 'scope mismatch is rejected before querying active reservations');
    } finally { h.close(); }
  });
});

test('a correlated duplicate remains readable under reservation without a second insert or admission assertion', async () => {
  const h = harness();
  try {
    const first = await h.create({ idempotencyKey: 'original-delivery', correlationId: 'run-chain', triggerDepth: 1 });
    const checks = h.stats().admissionChecks;
    h.setReserved(true);
    const duplicate = await h.create({ idempotencyKey: 'replayed-delivery', correlationId: 'run-chain', triggerDepth: 1 });
    assert.equal(first.created, true);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.row.operation_id, first.row.operation_id);
    assert.equal(h.stats().admissionChecks, checks);
    assert.equal(h.stats().insertAttempts, 1);
    assert.equal(h.rows().size, 1);
  } finally { h.close(); }
});
