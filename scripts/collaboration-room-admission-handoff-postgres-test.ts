import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import * as Y from 'yjs';

import type { SqlConnection } from '../app/lib/db';
import {
  collaborationAdmissionActionDigest,
  CollaborationAdmissionError,
  type CollaborationAdmissionDocument,
  type CollaborationAdmissionRequest,
  type CollaborationAdmissionScope,
} from '../app/lib/collaboration/room-admission-contract';
import { createCollaborationAdmissionService } from '../app/lib/collaboration/room-admission';
import { createCollaborationAdmissionQuiescenceService } from '../app/lib/collaboration/room-admission-quiescence';
import { createCollaborationAdmissionHandoffService } from '../app/lib/collaboration/room-admission-handoff';
import type { CollaborationAdmissionDrainTicket } from '../app/lib/collaboration/room-admission-drain';
import {
  assertCollaborationRoomOwnerFence,
  CollaborationRoomOwnerError,
  createCollaborationRoomOwnerSession,
  lockIdentity,
  type CollaborationRoomOwnerFence,
} from '../app/lib/collaboration/room-owner';
import {
  recoverCollaborationRoomRelease,
  type CollaborationRoomReleaseSnapshot,
} from '../app/lib/collaboration/room-owner-release';
import { COLLABORATION_ADMISSION_STATEMENTS } from '../app/lib/db/collaboration-admission-migration';
import {
  COLLABORATION_ROOM_OWNER_UP_SQL,
  COLLABORATION_ROOM_RELEASE_UP_SQL,
} from '../app/lib/db/collaboration-room-owner-migration';

const SCHEMA_PREFIX = 'canvas_admission_handoff_test_';
const GENERATED_SCHEMA = new RegExp(`^${SCHEMA_PREFIX}[0-9a-f]{32}$`, 'u');
const STATEMENT_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_MS = 8_000;
const OPERATION_TIMEOUT_MS = 20_000;
const CLEANUP_TIMEOUT_MS = 20_000;

type OwnerSession = Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>>;
type HandoffService = ReturnType<typeof createCollaborationAdmissionHandoffService>;
type MutationWrapper = <T>(workspaceIds: readonly string[], operation: () => Promise<T>) => Promise<T>;
type StateRow = {
  document_id: string;
  workspace_id: string;
  organization_id: string | null;
  path: string;
  representation: string;
  lifecycle_generation: number | string;
  schema_version: number | string;
  status: string;
  yjs_state: Uint8Array;
  state_vector: Uint8Array;
  document_sequence: number | string;
  room_owner_epoch: number | string;
  room_owner_token: string | null;
  room_owner_backend_pid: number | null;
  room_owner_backend_start: string | null;
};
type Gate = { promise: Promise<void>; resolve: () => void };

function deferred(): Gate {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve };
}

function guardedDatabaseUrl(): URL | null {
  if (process.env.CANVAS_DATABASE_PROVIDER !== 'postgres' || !process.env.DATABASE_URL) return null;
  let parsed: URL;
  try { parsed = new URL(process.env.DATABASE_URL); }
  catch { throw new Error('Admission-handoff PostgreSQL test refused a malformed DATABASE_URL.'); }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !['localhost', '127.0.0.1'].includes(parsed.hostname)
    || parsed.port !== '55433' || databaseName !== 'canvas_notebook') {
    throw new Error('Admission-handoff PostgreSQL test only accepts managed loopback PG18 at 55433/canvas_notebook.');
  }
  return parsed;
}

function assertGeneratedSchema(schema: string): void {
  if (!GENERATED_SCHEMA.test(schema)) throw new Error('Refusing SQL outside the generated admission-handoff test namespace.');
}

function schemaIdentifier(schema: string): string {
  assertGeneratedSchema(schema);
  return `"${schema}"`;
}

function normalizedSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim().toUpperCase();
}

function poolConfig(databaseUrl: URL, applicationName: string, searchPath?: string) {
  if (searchPath) assertGeneratedSchema(searchPath);
  return {
    connectionString: databaseUrl.toString(), application_name: applicationName,
    connectionTimeoutMillis: 3_000, idleTimeoutMillis: 2_000, allowExitOnIdle: true,
    options: [searchPath ? `-c search_path=${searchPath}` : '',
      `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`, `-c lock_timeout=${LOCK_TIMEOUT_MS}`]
      .filter(Boolean).join(' '),
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function verifyManagedPostgres(pool: Pool): Promise<void> {
  const result = await pool.query<{ database_name: string; server_version_num: string; source_table_exists: boolean }>(
    `SELECT current_database() AS database_name, current_setting('server_version_num') AS server_version_num,
      to_regclass('public.collaboration_yjs_states') IS NOT NULL AS source_table_exists`,
  );
  const row = result.rows[0];
  if (!row || row.database_name !== 'canvas_notebook'
    || Math.floor(Number(row.server_version_num) / 10_000) !== 18 || row.source_table_exists !== true) {
    throw new Error('Admission-handoff PostgreSQL test refused a server outside managed PG18.');
  }
}

function sanitizeError(error: unknown): string {
  const candidate = error && typeof error === 'object'
    ? error as { code?: unknown; message?: unknown; name?: unknown } : {};
  const name = typeof candidate.name === 'string' && /^[A-Za-z][A-Za-z0-9]*$/u.test(candidate.name)
    ? candidate.name : 'Error';
  const code = typeof candidate.code === 'string' && /^[A-Z0-9_]{1,40}$/u.test(candidate.code)
    ? ` [${candidate.code}]` : '';
  const message = typeof candidate.message === 'string' ? candidate.message : 'Unknown test failure.';
  return `${name}${code}: ${message}`.replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/password\s*=\s*\S+/giu, 'password=[redacted]');
}

function admissionError(...codes: CollaborationAdmissionError['code'][]) {
  return (error: unknown) => {
    assert.ok(error instanceof CollaborationAdmissionError);
    assert.ok(codes.includes(error.code), `expected ${codes.join(' or ')}, received ${error.code}`);
    return true;
  };
}

function ownerBusy(error: unknown): boolean {
  assert.ok(error instanceof CollaborationRoomOwnerError);
  assert.equal(error.code, 'ROOM_OWNER_BUSY');
  return true;
}

function scope(path: string, workspaceId = 'workspace-handoff'): CollaborationAdmissionScope {
  return { workspaceId, organizationId: 'organization-handoff', path, kind: 'exact' };
}

function document(documentId: string, path = `${documentId}.md`, workspaceId = 'workspace-handoff'):
CollaborationAdmissionDocument {
  return { documentId, workspaceId, organizationId: 'organization-handoff', path,
    representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1, status: 'active' };
}

function request(
  expectedDocuments: readonly CollaborationAdmissionDocument[],
  label: string,
  payload: Record<string, unknown>,
  explicitScopes?: readonly CollaborationAdmissionScope[],
): CollaborationAdmissionRequest {
  const actionPayloadText = JSON.stringify(payload);
  const sourceScopes = expectedDocuments.map((expected) => scope(expected.path, expected.workspaceId));
  const destinationPath = payload.destinationPath;
  const destinationWorkspaceId = typeof payload.destinationWorkspaceId === 'string'
    ? payload.destinationWorkspaceId : expectedDocuments[0]?.workspaceId;
  const destinationScope = typeof destinationPath === 'string' && destinationWorkspaceId
    ? [{ workspaceId: destinationWorkspaceId, organizationId: expectedDocuments[0]?.organizationId ?? null,
      path: destinationPath, kind: destinationPath === '' ? 'subtree' as const : 'exact' as const }]
    : [];
  return { requestId: randomUUID(), actorId: `actor-handoff-${label}`, action: 'move',
    actionPayloadText, actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
    scopes: explicitScopes ?? [...sourceScopes, ...destinationScope], expectedDocuments };
}

async function run(databaseUrl: URL): Promise<void> {
  const schema = `${SCHEMA_PREFIX}${randomUUID().replaceAll('-', '')}`;
  assertGeneratedSchema(schema);
  const schemaSql = schemaIdentifier(schema);
  const stateTable = `${schemaSql}.collaboration_yjs_states`;
  const looseClients = new Set<Client>();
  const ownerSessions = new Set<OwnerSession>();
  const cleanupErrors: unknown[] = [];
  const backgroundErrors: Error[] = [];
  const controlPool = new Pool({ ...poolConfig(databaseUrl, 'canvas-admission-handoff-control'), max: 4 });
  controlPool.on('error', (error) => { backgroundErrors.push(error); });
  let schemaCreated = false;

  const createConnectedClient = async (label: string): Promise<Client> => {
    const client = new Client({ ...poolConfig(databaseUrl, `canvas-admission-handoff-${label}`, schema) });
    looseClients.add(client);
    await client.connect();
    return client;
  };
  const openConnection = (label: string) => async (): Promise<SqlConnection> => {
    const client = await createConnectedClient(label);
    let closed = false;
    return {
      get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
      all: async (sql, params = []) => (await client.query(sql, params)).rows,
      run: async (sql, params = []) => ({ changes: (await client.query(sql, params)).rowCount ?? 0 }),
      close: async () => {
        assert.equal(closed, false, 'an admission-handoff connection must close exactly once');
        closed = true;
        await client.end();
        looseClients.delete(client);
      },
    };
  };
  const createOwner = async (label: string) => {
    const client = await createConnectedClient(`owner-${label}`);
    const session = await createCollaborationRoomOwnerSession(client);
    ownerSessions.add(session);
    looseClients.delete(client);
    return { client, session };
  };
  const admission = createCollaborationAdmissionService({ openConnection: openConnection('admission') });
  const quiescence = createCollaborationAdmissionQuiescenceService({ openConnection: openConnection('quiescence') });

  const encode = (content: string) => {
    const doc = new Y.Doc();
    try {
      doc.getText('content').insert(0, content);
      return { yjsState: Buffer.from(Y.encodeStateAsUpdate(doc)), stateVector: Buffer.from(Y.encodeStateVector(doc)) };
    } finally { doc.destroy(); }
  };
  const seed = async (expected: CollaborationAdmissionDocument, content = expected.documentId) => {
    const state = encode(content);
    await controlPool.query(`INSERT INTO ${stateTable} (
      document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
      yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
      canonical_hash,serialized_hash,newline_style,has_bom,degraded,status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,$10,0,NULL,NULL,'lf',0,0,$11)`,
    [expected.documentId, expected.workspaceId, expected.organizationId, expected.path, expected.representation,
      expected.lifecycleGeneration, expected.schemaVersion, state.yjsState, state.stateVector, Date.now(), expected.status]);
  };
  const readState = async (documentId: string) => {
    const result = await controlPool.query<StateRow>(`SELECT * FROM ${stateTable} WHERE document_id=$1`, [documentId]);
    assert.equal(result.rows.length, 1);
    return result.rows[0]!;
  };
  const storeSnapshot = async (fence: CollaborationRoomOwnerFence, content: string,
    admissionTicket?: CollaborationAdmissionDrainTicket):
  Promise<CollaborationRoomReleaseSnapshot> => {
    const client = await createConnectedClient(`store-${fence.scope.documentId}`);
    const state = encode(content);
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const row = (await client.query<StateRow>(
        'SELECT * FROM collaboration_yjs_states WHERE document_id=$1 FOR UPDATE', [fence.scope.documentId],
      )).rows[0];
      assert.ok(row);
      await assertCollaborationRoomOwnerFence({
        get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
      }, row, fence);
      await client.query(`UPDATE collaboration_yjs_states SET yjs_state=$2,state_vector=$3,
        document_sequence=document_sequence+1 WHERE document_id=$1`,
      [fence.scope.documentId, state.yjsState, state.stateVector]);
      await client.query('COMMIT');
      transactionOpen = false;
      return Object.freeze({ releaseId: admissionTicket?.releaseId ?? randomUUID(),
        ...(admissionTicket ? { admission: admissionTicket } : {}),
        yjsState: new Uint8Array(state.yjsState), stateVector: new Uint8Array(state.stateVector) });
    } catch (error) {
      if (transactionOpen) await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
      looseClients.delete(client);
    }
  };
  const reserveAndProve = async (input: CollaborationAdmissionRequest) => {
    await admission.reserve(input);
    for (const expected of input.expectedDocuments) await quiescence.prove(input, expected.documentId);
  };
  const roomLockAvailable = async (documentId: string, label: string) => {
    const client = await createConnectedClient(`probe-${label}`);
    const key = lockIdentity(documentId).key;
    try {
      const locked = (await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1::bigint) AS locked', [key],
      )).rows[0]?.locked === true;
      if (locked) await client.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
      return locked;
    } finally {
      await client.end();
      looseClients.delete(client);
    }
  };
  const createHandoff = (label: string, options: {
    open?: () => Promise<SqlConnection>;
    mutation?: MutationWrapper;
  } = {}): HandoffService => createCollaborationAdmissionHandoffService({
    openConnection: options.open ?? openConnection(`handoff-${label}`),
    withMutationLocks: (workspaceIds, operation) => options.mutation
      ? options.mutation(workspaceIds, operation)
      : operation(),
  });

  try {
    await verifyManagedPostgres(controlPool);
    await controlPool.query(`CREATE SCHEMA ${schemaSql}`);
    schemaCreated = true;
    await controlPool.query(`CREATE TABLE ${stateTable} (LIKE public.collaboration_yjs_states INCLUDING ALL)`);
    const migrationClient = await createConnectedClient('migration');
    assert.equal((await migrationClient.query<{ search_path: string }>('SHOW search_path')).rows[0]?.search_path, schema);
    for (let pass = 0; pass < 3; pass++) {
      await migrationClient.query(COLLABORATION_ROOM_OWNER_UP_SQL);
      await migrationClient.query(COLLABORATION_ROOM_RELEASE_UP_SQL);
      for (const statement of COLLABORATION_ADMISSION_STATEMENTS) await migrationClient.query(statement);
      if (pass === 0) {
        // ADD COLUMN IF NOT EXISTS cannot expand an existing three-kind CHECK.
        await migrationClient.query(`ALTER TABLE collaboration_admission_targets
          DROP CONSTRAINT collaboration_admission_targets_quiescence_kind_check`);
        await migrationClient.query(`ALTER TABLE collaboration_admission_targets
          ADD CONSTRAINT collaboration_admission_targets_quiescence_kind_check CHECK
            (quiescence_kind IS NULL OR quiescence_kind IN ('vacant', 'normal_release', 'owner_drain'))`);
      } else {
        const check = await migrationClient.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition
          FROM pg_constraint WHERE conrelid = 'collaboration_admission_targets'::regclass
            AND conname = 'collaboration_admission_targets_quiescence_kind_check'`);
        assert.match(check.rows[0].definition, /lifecycle_outcome/u);
      }
    }
    await migrationClient.end();
    looseClients.delete(migrationClient);

    // Room guards are held before the external workspace lock wrapper and through the actual SQL mutation.
    const pausedDoc = document('handoff-paused', 'paused-old.md');
    await seed(pausedDoc);
    const pausedRequest = request([pausedDoc], 'paused', { destinationPath: 'paused-new.md' });
    await reserveAndProve(pausedRequest);
    const mutationEntered = deferred();
    const releaseMutation = deferred();
    let mutationDepth = 0;
    const pausedHandoff = createHandoff('paused', {
      mutation: async (workspaceIds, operation) => {
        assert.deepEqual(workspaceIds, ['workspace-handoff']);
        assert.equal(await roomLockAvailable(pausedDoc.documentId, 'paused-inside-workspace'), false,
          'room guard is already held before entering workspace mutation locks');
        mutationDepth += 1;
        mutationEntered.resolve();
        await releaseMutation.promise;
        try { return await operation(); }
        finally { mutationDepth -= 1; }
      },
    });
    let pausedMutations = 0;
    const pausedExecution = pausedHandoff.execute(pausedRequest, {
      authorize: async () => undefined,
      prepare: async (database) => {
        assert.equal(mutationDepth, 1);
        assert.ok(await database.get('SELECT document_id FROM collaboration_yjs_states WHERE document_id=$1',
          [pausedDoc.documentId]));
      },
      mutate: async (database) => {
        pausedMutations += 1;
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [pausedDoc.documentId, 'paused-new.md']);
        return { destinationPath: 'paused-new.md' };
      },
    });
    await within(mutationEntered.promise, OPERATION_TIMEOUT_MS, 'handoff did not enter workspace mutation lock');
    const competingOwner = await createOwner('paused-competitor');
    await assert.rejects(competingOwner.session.acquire({ ...pausedDoc }), ownerBusy,
      'a competing claim remains blocked while the guarded mutation is paused');
    assert.equal(pausedMutations, 0, 'mutation callback waits inside the controlled workspace barrier');
    releaseMutation.resolve();
    const pausedOutcome = await within(pausedExecution, OPERATION_TIMEOUT_MS, 'paused handoff did not complete');
    assert.equal(pausedOutcome.result.destinationPath, 'paused-new.md');
    assert.equal((await readState(pausedDoc.documentId)).path, 'paused-new.md');
    assert.equal(Object.isFrozen(pausedOutcome), true);
    assert.equal(Object.isFrozen(pausedOutcome.result), true);
    assert.equal(Object.isFrozen(pausedOutcome.targets), true);

    // The stored outcome is immutable and a same-ID retry never invokes callbacks again.
    const defaultHandoff = createHandoff('default');
    assert.deepEqual(await defaultHandoff.readOutcome(pausedRequest), pausedOutcome);
    const retryOutcome = await defaultHandoff.execute(pausedRequest, {
      authorize: async () => undefined,
      prepare: async () => { throw new Error('same-ID retry reran prepare'); },
      mutate: async () => { throw new Error('same-ID retry reran mutate'); },
    });
    assert.deepEqual(retryOutcome, pausedOutcome);
    assert.equal(pausedMutations, 1);
    const revoked = new Error('Injected revoked authorization.');
    const noReadAfterRevocation = createHandoff('revoked', {
      open: async () => { throw new Error('authorization failure reached SQL'); },
    });
    await assert.rejects(noReadAfterRevocation.execute(pausedRequest, {
      authorize: async () => { throw revoked; },
      prepare: async () => { throw new Error('authorization failure reached prepare'); },
      mutate: async () => { throw new Error('authorization failure reached mutate'); },
    }), (error: unknown) => error === revoked);

    // A fresh service resumes from canonical request text after a normal owner release.
    const resumeDoc = document('handoff-resume', 'resume-old.md');
    await seed(resumeDoc);
    const resumeOwner = await createOwner('resume');
    const resumeFence = await resumeOwner.session.acquire({ ...resumeDoc });
    const resumeRequest = request([resumeDoc], 'resume', { destinationPath: 'resume-new.md' });
    await admission.reserve(resumeRequest);
    const resumeSnapshot = await storeSnapshot(resumeFence, 'resume-final');
    await resumeOwner.session.release(resumeFence, resumeSnapshot);
    await quiescence.prove(resumeRequest, resumeDoc.documentId);
    const freshHandoff = createHandoff('fresh-resume');
    const loadedResumeRequest = await freshHandoff.loadRequest(resumeRequest.requestId);
    assert.equal(loadedResumeRequest?.requestId, resumeRequest.requestId);
    assert.deepEqual(loadedResumeRequest?.expectedDocuments, resumeRequest.expectedDocuments);
    assert.deepEqual(new Set(loadedResumeRequest?.scopes.map((item) => item.path)),
      new Set(resumeRequest.scopes.map((item) => item.path)));
    assert.ok(loadedResumeRequest?.actionPayloadText);
    const loadedResumePayload = JSON.parse(loadedResumeRequest.actionPayloadText) as { destinationPath: string };
    const resumeOutcome = await freshHandoff.execute(loadedResumeRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [resumeDoc.documentId, loadedResumePayload.destinationPath]);
        return { destinationPath: loadedResumePayload.destinationPath };
      },
    });
    assert.equal(resumeOutcome.result.destinationPath, 'resume-new.md');

    // The exact prior lifecycle outcome can authorize a second same-epoch action after the scope changed.
    const secondDoc = { ...resumeDoc, path: 'resume-new.md' };
    const secondRequest = request([secondDoc], 'second-same-epoch', { destinationPath: 'resume-final.md' });
    await admission.reserve(secondRequest);
    const secondProof = await quiescence.prove(secondRequest, secondDoc.documentId);
    assert.equal(secondProof.kind, 'lifecycle_outcome');
    assert.equal(secondProof.sourceOutcomeRequestId, resumeRequest.requestId);
    const secondOutcome = await defaultHandoff.execute(secondRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [secondDoc.documentId, 'resume-final.md']);
        return { destinationPath: 'resume-final.md' };
      },
    });
    assert.equal(secondOutcome.result.destinationPath, 'resume-final.md');
    assert.equal(Number((await readState(secondDoc.documentId)).room_owner_epoch), resumeFence.epoch,
      'both lifecycle actions retain the released owner epoch');

    // Positive archive/restore transitions chain through exact outcomes without inventing a new owner epoch.
    const beforeArchive = await readState(secondDoc.documentId);
    const archiveDoc: CollaborationAdmissionDocument = { ...secondDoc, path: 'resume-final.md' };
    const archivePayloadText = JSON.stringify({ documentId: archiveDoc.documentId });
    const archiveRequest: CollaborationAdmissionRequest = {
      requestId: randomUUID(), actorId: 'actor-handoff-archive', action: 'archive', actionPayloadText: archivePayloadText,
      actionDigest: collaborationAdmissionActionDigest('archive', archivePayloadText),
      scopes: [scope(archiveDoc.path, archiveDoc.workspaceId)], expectedDocuments: [archiveDoc],
    };
    await admission.reserve(archiveRequest);
    const archiveProof = await quiescence.prove(archiveRequest, archiveDoc.documentId);
    assert.equal(archiveProof.kind, 'lifecycle_outcome');
    assert.equal(archiveProof.sourceOutcomeRequestId, secondRequest.requestId);
    await defaultHandoff.execute(archiveRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run(`UPDATE collaboration_yjs_states SET status='archived',
          lifecycle_generation=lifecycle_generation+1, document_sequence=document_sequence+1 WHERE document_id=$1`,
        [archiveDoc.documentId]);
        return { status: 'archived' };
      },
    });
    const archivedState = await readState(archiveDoc.documentId);
    assert.equal(archivedState.status, 'archived');
    assert.equal(Number(archivedState.lifecycle_generation), 2);
    assert.equal(Number(archivedState.room_owner_epoch), resumeFence.epoch);
    assert.equal(Buffer.from(archivedState.yjs_state).equals(Buffer.from(beforeArchive.yjs_state)), true);
    assert.equal(Buffer.from(archivedState.state_vector).equals(Buffer.from(beforeArchive.state_vector)), true);

    const archivedDoc: CollaborationAdmissionDocument = {
      ...archiveDoc, lifecycleGeneration: 2, status: 'archived',
    };
    const restorePayloadText = JSON.stringify({ documentId: archivedDoc.documentId });
    const restoreRequest: CollaborationAdmissionRequest = {
      requestId: randomUUID(), actorId: 'actor-handoff-restore', action: 'restore', actionPayloadText: restorePayloadText,
      actionDigest: collaborationAdmissionActionDigest('restore', restorePayloadText),
      scopes: [scope(archivedDoc.path, archivedDoc.workspaceId)], expectedDocuments: [archivedDoc],
    };
    await admission.reserve(restoreRequest);
    const restoreProof = await quiescence.prove(restoreRequest, archivedDoc.documentId);
    assert.equal(restoreProof.kind, 'lifecycle_outcome');
    assert.equal(restoreProof.sourceOutcomeRequestId, archiveRequest.requestId);
    await defaultHandoff.execute(restoreRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run(`UPDATE collaboration_yjs_states SET status='active',
          lifecycle_generation=lifecycle_generation+1, document_sequence=document_sequence+1 WHERE document_id=$1`,
        [archivedDoc.documentId]);
        return { status: 'active' };
      },
    });
    const restoredState = await readState(archivedDoc.documentId);
    assert.equal(restoredState.status, 'active');
    assert.equal(Number(restoredState.lifecycle_generation), 3);
    assert.equal(Number(restoredState.room_owner_epoch), resumeFence.epoch);
    assert.equal(Buffer.from(restoredState.yjs_state).equals(Buffer.from(beforeArchive.yjs_state)), true);
    assert.equal(Buffer.from(restoredState.state_vector).equals(Buffer.from(beforeArchive.state_vector)), true);
    const restoredOwner = await createOwner('archive-restore-final');
    const restoredFence = await restoredOwner.session.acquire({ ...archiveDoc, lifecycleGeneration: 3 });
    assert.ok(restoredFence.epoch > resumeFence.epoch);

    // Lost successful COMMIT recovery runs after workspace unwinds and tolerates a replacement owner.
    const lostDoc = document('handoff-lost-commit', 'lost-old.md');
    await seed(lostDoc);
    const lostRequest = request([lostDoc], 'lost-commit', { destinationPath: 'lost-new.md' });
    await reserveAndProve(lostRequest);
    let lostOpens = 0;
    let lostClosed = false;
    let lostMutationDepth = 0;
    let replacementFence: CollaborationRoomOwnerFence | undefined;
    const replacementOwner = await createOwner('lost-replacement');
    const lostFactory = async (): Promise<SqlConnection> => {
      lostOpens += 1;
      if (lostOpens === 3) {
        assert.equal(lostClosed, true, 'outcome recovery starts only after uncertain backend close');
        assert.equal(lostMutationDepth, 0, 'outcome recovery is outside workspace mutation locks');
        replacementFence ??= await replacementOwner.session.acquire({ ...lostDoc, path: 'lost-new.md' });
        return openConnection('lost-recovery')();
      }
      const database = await openConnection(`lost-${lostOpens}`)();
      if (lostOpens === 1) return database;
      assert.equal(lostOpens, 2, 'only the guarded mutation connection precedes recovery');
      return {
        ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost handoff COMMIT reply.');
          return result;
        },
        close: async (error) => { await database.close(error); lostClosed = true; },
      };
    };
    let lostMutations = 0;
    const lostHandoff = createHandoff('lost', {
      open: lostFactory,
      mutation: async (_workspaceIds, operation) => {
        lostMutationDepth += 1;
        try { return await operation(); } finally { lostMutationDepth -= 1; }
      },
    });
    const lostOutcome = await lostHandoff.execute(lostRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        lostMutations += 1;
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [lostDoc.documentId, 'lost-new.md']);
        return { destinationPath: 'lost-new.md' };
      },
    });
    assert.equal(lostMutations, 1);
    assert.equal(lostOpens, 3, 'lost COMMIT uses preflight, mutation, then one unguarded recovery read');
    assert.ok(replacementFence);
    assert.equal(lostOutcome.result.destinationPath, 'lost-new.md');

    // A rejected COMMIT leaves the reservation/proof active; the exact retry performs the mutation once.
    const rejectedDoc = document('handoff-rejected-commit', 'rejected-old.md');
    await seed(rejectedDoc);
    const rejectedRequest = request([rejectedDoc], 'rejected-commit', { destinationPath: 'rejected-new.md' });
    await reserveAndProve(rejectedRequest);
    let rejectedOpens = 0;
    const rejectedFactory = async (): Promise<SqlConnection> => {
      rejectedOpens += 1;
      const database = await openConnection(`rejected-${rejectedOpens}`)();
      if (rejectedOpens !== 2) return database;
      return { ...database, run: async (sql, params = []) => {
        if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected rejected handoff COMMIT.');
        return database.run(sql, params);
      } };
    };
    let rejectedMutations = 0;
    await assert.rejects(createHandoff('rejected', { open: rejectedFactory }).execute(rejectedRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        rejectedMutations += 1;
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [rejectedDoc.documentId, 'rejected-new.md']);
        return { destinationPath: 'rejected-new.md' };
      },
    }), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    assert.equal((await readState(rejectedDoc.documentId)).path, 'rejected-old.md');
    assert.equal(await defaultHandoff.readOutcome(rejectedRequest), null);
    const activeRejected = await controlPool.query<{ status: string; active: boolean }>(
      `SELECT status,active FROM ${schemaSql}.collaboration_admission_targets WHERE request_id=$1`,
      [rejectedRequest.requestId],
    );
    assert.deepEqual(activeRejected.rows[0], { status: 'released', active: true });
    const rejectedRetry = await defaultHandoff.execute(rejectedRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        rejectedMutations += 1;
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [rejectedDoc.documentId, 'rejected-new.md']);
        return { destinationPath: 'rejected-new.md' };
      },
    });
    assert.equal(rejectedRetry.result.destinationPath, 'rejected-new.md');
    assert.equal(rejectedMutations, 2, 'rolled-back callback runs exactly once again on explicit exact retry');

    // Scope phantoms introduced after reservation are caught after fresh prepare but before mutate.
    const phantomDoc = document('handoff-phantom-source', 'phantom/source.md');
    await seed(phantomDoc);
    const phantomRequest = request([phantomDoc], 'phantom', { destinationPath: 'phantom/moved.md' },
      [{ workspaceId: phantomDoc.workspaceId, organizationId: phantomDoc.organizationId,
        path: 'phantom', kind: 'subtree' }]);
    await reserveAndProve(phantomRequest);
    await seed(document('handoff-phantom-late', 'phantom/late.md'));
    let phantomPrepares = 0;
    let phantomMutations = 0;
    await assert.rejects(defaultHandoff.execute(phantomRequest, {
      authorize: async () => undefined,
      prepare: async () => { phantomPrepares += 1; },
      mutate: async () => { phantomMutations += 1; return {}; },
    }), admissionError('ADMISSION_SCOPE_CHANGED'));
    assert.equal(phantomPrepares, 1);
    assert.equal(phantomMutations, 0);

    // Callback failure rolls back its SQL and retains the proven active target for an exact retry.
    const thrownDoc = document('handoff-mutate-throw', 'throw-old.md');
    await seed(thrownDoc);
    const thrownRequest = request([thrownDoc], 'mutate-throw', { destinationPath: 'throw-new.md' });
    await reserveAndProve(thrownRequest);
    const callbackFailure = new Error('Injected mutation callback failure.');
    await assert.rejects(defaultHandoff.execute(thrownRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [thrownDoc.documentId, 'throw-new.md']);
        throw callbackFailure;
      },
    }), (error: unknown) => error === callbackFailure);
    assert.equal((await readState(thrownDoc.documentId)).path, thrownDoc.path);
    assert.equal(await defaultHandoff.readOutcome(thrownRequest), null);

    // Post-state epoch, generation, and sequence regressions are rejected and fully rolled back.
    const regressionCases: Array<{
      label: string;
      expected: CollaborationAdmissionDocument;
      beforeReserve?: () => Promise<void>;
      ownerRelease?: boolean;
      mutate: (database: SqlConnection) => Promise<void>;
      assertUnchanged: (row: StateRow, fence?: CollaborationRoomOwnerFence) => void;
    }> = [];
    const generationDoc = { ...document('handoff-regress-generation', 'regress-generation.md'), lifecycleGeneration: 2 };
    regressionCases.push({ label: 'generation', expected: generationDoc,
      mutate: async (database) => { await database.run(
        'UPDATE collaboration_yjs_states SET lifecycle_generation=1 WHERE document_id=$1', [generationDoc.documentId]); },
      assertUnchanged: (row) => { assert.equal(Number(row.lifecycle_generation), 2); } });
    const sequenceDoc = document('handoff-regress-sequence', 'regress-sequence.md');
    regressionCases.push({ label: 'sequence', expected: sequenceDoc,
      beforeReserve: async () => { await controlPool.query(`UPDATE ${stateTable} SET document_sequence=2 WHERE document_id=$1`,
        [sequenceDoc.documentId]); },
      mutate: async (database) => { await database.run(
        'UPDATE collaboration_yjs_states SET document_sequence=1 WHERE document_id=$1', [sequenceDoc.documentId]); },
      assertUnchanged: (row) => { assert.equal(Number(row.document_sequence), 2); } });
    const epochDoc = document('handoff-regress-epoch', 'regress-epoch.md');
    regressionCases.push({ label: 'epoch', expected: epochDoc, ownerRelease: true,
      mutate: async (database) => { await database.run(
        'UPDATE collaboration_yjs_states SET room_owner_epoch=0 WHERE document_id=$1', [epochDoc.documentId]); },
      assertUnchanged: (row, fence) => { assert.equal(Number(row.room_owner_epoch), fence?.epoch); } });
    for (const regression of regressionCases) {
      await seed(regression.expected);
      await regression.beforeReserve?.();
      let regressionFence: CollaborationRoomOwnerFence | undefined;
      if (regression.ownerRelease) {
        const owner = await createOwner(`regress-${regression.label}`);
        regressionFence = await owner.session.acquire({ ...regression.expected });
        const snapshot = await storeSnapshot(regressionFence, `regress-${regression.label}-final`);
        await owner.session.release(regressionFence, snapshot);
      }
      const input = request([regression.expected], `regress-${regression.label}`,
        { destinationPath: `regress-${regression.label}-new.md` });
      await reserveAndProve(input);
      let mutations = 0;
      await assert.rejects(defaultHandoff.execute(input, {
        authorize: async () => undefined,
        prepare: async () => undefined,
        mutate: async (database) => {
          mutations += 1;
          await regression.mutate(database);
          return { attempted: regression.label };
        },
      }), admissionError('ADMISSION_SCOPE_CHANGED'));
      assert.equal(mutations, 1);
      regression.assertUnchanged(await readState(regression.expected.documentId), regressionFence);
      assert.equal(await defaultHandoff.readOutcome(input), null);
    }

    // A lost COMMIT followed by a failed discard never opens recovery; the durable outcome remains inspectable later.
    const closeFailureDoc = document('handoff-close-failure', 'close-failure-old.md');
    await seed(closeFailureDoc);
    const closeFailureRequest = request([closeFailureDoc], 'close-failure',
      { destinationPath: 'close-failure-new.md' });
    await reserveAndProve(closeFailureRequest);
    let closeFailureOpens = 0;
    let closeFailureWorkspaceDepth = 0;
    const discardFailure = new Error('Injected discard failure after ending backend.');
    const closeFailureFactory = async (): Promise<SqlConnection> => {
      closeFailureOpens += 1;
      const database = await openConnection(`close-failure-${closeFailureOpens}`)();
      if (closeFailureOpens !== 2) return database;
      return { ...database,
        run: async (sql, params = []) => {
          const result = await database.run(sql, params);
          if (normalizedSql(sql) === 'COMMIT') throw new Error('Injected lost COMMIT response.');
          return result;
        },
        close: async (error) => { await database.close(error); throw discardFailure; } };
    };
    await assert.rejects(createHandoff('close-failure', {
      open: closeFailureFactory,
      mutation: async (_workspaceIds, operation) => {
        closeFailureWorkspaceDepth += 1;
        try { return await operation(); } finally { closeFailureWorkspaceDepth -= 1; }
      },
    }).execute(closeFailureRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [closeFailureDoc.documentId, 'close-failure-new.md']);
        return { destinationPath: 'close-failure-new.md' };
      },
    }), (error: unknown) => error instanceof AggregateError || error === discardFailure);
    assert.equal(closeFailureOpens, 2, 'failed backend discard suppresses automatic recovery reads');
    assert.equal(closeFailureWorkspaceDepth, 0);
    assert.equal((await defaultHandoff.readOutcome(closeFailureRequest))?.result.destinationPath,
      'close-failure-new.md', 'a later trusted read can observe the actually committed outcome');

    // Stale and receipt-less owner releases can prepare, but never enter the mutation callback.
    let stalePrepares = 0;
    let forbiddenMutations = 0;
    for (const [label, stale] of [['stale', true], ['no-receipt', false]] as const) {
      const expected = document(`handoff-${label}`);
      await seed(expected);
      const owner = await createOwner(label);
      const fence = await owner.session.acquire({ ...expected });
      const input = request([expected], label, { destinationPath: `${label}-new.md` });
      await admission.reserve(input);
      if (stale) await owner.session.close();
      else await owner.session.release(fence);
      await assert.rejects(defaultHandoff.execute(input, {
        authorize: async () => undefined,
        prepare: async () => { stalePrepares += 1; },
        mutate: async () => { forbiddenMutations += 1; return {}; },
      }), admissionError('ADMISSION_RECOVERY_REQUIRED'));
    }
    assert.equal(stalePrepares, 2, 'fresh prepare runs before shared-state proof as required by the domain contract');
    assert.equal(forbiddenMutations, 0);

    // If one of several sorted room guards is busy, earlier guards are released and no mutation lock starts.
    const multiA = document('handoff-multi-a');
    const multiZ = document('handoff-multi-z');
    await seed(multiA);
    await seed(multiZ);
    const multiRequest = request([multiA, multiZ], 'multi-busy', { destinationPath: 'multi-destination' });
    await reserveAndProve(multiRequest);
    const [firstGuard, busyGuard] = [multiA, multiZ].sort((left, right) =>
      BigInt(lockIdentity(left.documentId).key) < BigInt(lockIdentity(right.documentId).key) ? -1 : 1);
    const busyClient = await createConnectedClient('multi-busy-holder');
    const busyKey = lockIdentity(busyGuard.documentId).key;
    assert.equal((await busyClient.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [busyKey])).rows[0]?.locked, true);
    let multiMutationLocks = 0;
    await assert.rejects(createHandoff('multi-busy', {
      mutation: async (_workspaceIds, operation) => { multiMutationLocks += 1; return operation(); },
    }).execute(multiRequest, {
      authorize: async () => undefined,
      prepare: async () => { stalePrepares += 1; },
      mutate: async () => { forbiddenMutations += 1; return {}; },
    }), admissionError('ADMISSION_CONFLICT'));
    assert.equal(multiMutationLocks, 0);
    assert.equal(forbiddenMutations, 0);
    assert.equal(await roomLockAvailable(firstGuard.documentId, 'multi-first-released'), true,
      'failure on the later busy room releases every earlier session guard');
    await busyClient.query('SELECT pg_advisory_unlock($1::bigint)', [busyKey]);
    await busyClient.end();
    looseClients.delete(busyClient);

    // A real terminal owner-drain remains immutable cleanup evidence after handoff and a replacement claim.
    const terminalDoc = document('handoff-terminal-finish', 'terminal-old.md');
    await seed(terminalDoc);
    const terminalOwner = await createOwner('terminal-old');
    const terminalFence = await terminalOwner.session.acquire({ ...terminalDoc });
    const terminalRequest = request([terminalDoc], 'terminal-finish', { destinationPath: 'terminal-new.md' });
    await admission.reserve(terminalRequest);
    const terminalTicket = await admission.startDrain(terminalRequest, terminalDoc.documentId);
    const terminalSnapshot = await storeSnapshot(terminalFence, 'terminal-durable-content', terminalTicket);
    await terminalOwner.session.release(terminalFence, terminalSnapshot);
    const terminalProof = await quiescence.prove(terminalRequest, terminalDoc.documentId);
    assert.equal(terminalProof.kind, 'owner_drain');
    const terminalOutcome = await defaultHandoff.execute(terminalRequest, {
      authorize: async () => undefined,
      prepare: async () => undefined,
      mutate: async (database) => {
        await database.run('UPDATE collaboration_yjs_states SET path=$2 WHERE document_id=$1',
          [terminalDoc.documentId, 'terminal-new.md']);
        return { destinationPath: 'terminal-new.md' };
      },
    });
    assert.equal(terminalOutcome.result.destinationPath, 'terminal-new.md');
    const terminalReplacement = await createOwner('terminal-replacement');
    const replacementTerminalFence = await terminalReplacement.session.acquire({
      ...terminalDoc, path: 'terminal-new.md',
    });
    assert.ok(replacementTerminalFence.epoch > terminalFence.epoch);
    assert.deepEqual(await admission.readDrain(terminalTicket), { ticket: terminalTicket, status: 'released' });
    assert.deepEqual(await admission.pendingDrains([terminalFence]), [terminalTicket]);
    const terminalReceipt = await recoverCollaborationRoomRelease({
      createClient: async () => {
        const client = new Client({ ...poolConfig(databaseUrl, 'canvas-admission-handoff-terminal-recovery', schema) });
        await client.connect();
        return client;
      },
      fence: terminalFence,
      snapshot: terminalSnapshot,
    });
    assert.equal(terminalReceipt.release_id, terminalTicket.releaseId);
    assert.equal(terminalReceipt.owner_epoch, terminalFence.epoch);
    assert.equal((await readState(terminalDoc.documentId)).path, 'terminal-new.md');

    // Legacy reservations without canonical action payload are never executable.
    const legacyDoc = document('handoff-legacy');
    await seed(legacyDoc);
    const legacyRequest: CollaborationAdmissionRequest = {
      requestId: randomUUID(), actorId: 'actor-handoff', action: 'move', actionDigest: 'a'.repeat(64),
      scopes: [scope(legacyDoc.path)], expectedDocuments: [legacyDoc],
    };
    await reserveAndProve(legacyRequest);
    await assert.rejects(defaultHandoff.execute(legacyRequest, {
      authorize: async () => undefined,
      prepare: async () => { stalePrepares += 1; },
      mutate: async () => { forbiddenMutations += 1; return {}; },
    }), admissionError('ADMISSION_INVALID_REQUEST'));
    assert.equal(forbiddenMutations, 0);

    assert.equal(backgroundErrors.length, 0, 'admission-handoff pools must not emit background errors');
    console.log(
      'Collaboration admission handoff PostgreSQL: 21 bounded cases passed—legacy CHECK upgrade and idempotent migration, guard-before-workspace ordering, paused claim '
      + 'fencing, real SQL move, immutable/authenticated retry, canonical fresh-service resume, same-epoch lifecycle chaining, '
      + 'positive archive/restore generation transitions and subsequent owner claim, '
      + 'lost- and rejected-COMMIT handling, scope-phantom and callback rollback, epoch/generation/sequence regression guards, '
      + 'failed-discard recovery suppression, stale/receipt-less callback fencing, multi-target guard cleanup, terminal '
      + 'owner-drain handoff/replacement/recovery, and legacy request rejection—in one isolated generated schema.',
    );
  } finally {
    for (const session of ownerSessions) {
      try { await within(session.close(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-handoff owner session.'); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const client of [...looseClients]) {
      try {
        await within(client.end(), CLEANUP_TIMEOUT_MS, 'Timed out closing an admission-handoff client.');
        looseClients.delete(client);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (schemaCreated && looseClients.size === 0) {
      try { await controlPool.query(`DROP SCHEMA ${schemaIdentifier(schema)} CASCADE`); }
      catch (error) { cleanupErrors.push(error); }
    }
    try { await within(controlPool.end(), CLEANUP_TIMEOUT_MS, 'Timed out draining admission-handoff control pool.'); }
    catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Admission-handoff cleanup failed.');
  }
}

const databaseUrl = guardedDatabaseUrl();
if (!databaseUrl) {
  console.log('Collaboration admission-handoff PostgreSQL test skipped: guarded managed database environment is not configured.');
} else {
  run(databaseUrl).catch((error) => { console.error(sanitizeError(error)); process.exitCode = 1; });
}
