/** Actual native-reader/owner-session admission regression. No host/browser is started. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client, types } from 'pg';
import { parse } from 'dotenv';
import { privateBytes } from './lib/owned-yjs-authority-qa';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { createCollaborationRoomOwnerSession as OwnerFactory } from '../app/lib/collaboration/room-owner';

let phase = 'private managed configuration';
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  const connectionString = parse(await privateBytes('/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert(!url.search && !url.hash);
  const schema = `native_read_owner_${randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^native_read_owner_[a-f0-9]{32}$/u);
  const previousEnv = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  const clients = new Set<Client>(); let created = false, dataRoot: string | undefined;
  let owner: Awaited<ReturnType<typeof OwnerFactory>> | undefined;
  try {
    phase = 'actual PG18 target and owner';
    await control.connect();
    const realm = (await control.query(`SELECT current_database() AS name,d.oid::text AS oid,current_user AS role,
      pg_get_userbyid(d.datdba) AS owner,current_setting('server_version_num') AS version
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
    assert.equal(realm.name, 'canvas_notebook'); assert.equal(realm.owner, realm.role);
    assert.equal(realm.role, decodeURIComponent(url.username)); assert.match(realm.oid, /^\d+$/u);
    assert.equal(Math.floor(Number(realm.version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const table of ['collaboration_documents', 'collaboration_yjs_states', 'collaboration_yjs_state_backups',
      'collaboration_agent_operations', 'collaboration_admission_requests', 'collaboration_admission_scopes', 'collaboration_admission_targets']) {
      await control.query(`CREATE TABLE "${schema}".${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-native-read-owner-'));
    Object.assign(process.env, { DATABASE_URL: connectionString, CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external',
      CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true', CANVAS_POSTGRES_VECTOR_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false',
      BETTER_AUTH_BASE_URL: 'https://canvas.test', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000` });
    globalThis.fetch = async () => { throw new Error('No external request is permitted in this isolated PG fixture.'); };
    const fresh = async () => {
      const client = new Client({ connectionString, connectionTimeoutMillis: 5000,
        types: { getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === types.builtins.INT8
          ? (value: string) => Number.parseInt(value, 10) : types.getTypeParser(oid, format) },
        options: `-c search_path=${schema},pg_catalog -c statement_timeout=10000 -c lock_timeout=4000` });
      clients.add(client); await client.connect();
      const actual = (await client.query(`SELECT current_database() AS name,d.oid::text AS oid,current_user AS role,current_schema() AS schema
        FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
      assert.equal(actual.name, realm.name); assert.equal(actual.oid, realm.oid); assert.equal(actual.role, realm.role); assert.equal(actual.schema, schema);
      return client;
    };
    const openConnection = async (): Promise<SqlConnection> => {
      const client = await fresh();
      return { get: async (sql, values) => (await client.query(sql, values)).rows[0],
        all: async (sql, values) => (await client.query(sql, values)).rows,
        run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }),
        close: async () => { await client.end(); clients.delete(client); } };
    };
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { withNativeWorkspaceFileRead } = await import('../app/lib/collaboration/workspace-native-file-read');
    const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
    const { collaborationAdmissionLockKey } = await import('../app/lib/collaboration/room-admission-contract');
    const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
    const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
    const { tryLockFileLifecycleCollaborationWriterAdmission } = await import('../app/lib/collaboration/file-lifecycle-writer-admission');
    const { withWorkspaceFileLifecycleGuard } = await import('../app/lib/files/workspace-file-lifecycle-guard');
    const { withWorkspaceFileLifecycleCollaborationWrite } = await import('../app/lib/collaboration/file-lifecycle-admission-context');
    const seed = await fresh();
    const workspace: WorkspaceContext = { workspaceId: `native-read-owner-${randomUUID()}`, workspaceType: 'personal',
      organizationId: null, ownerUserId: 'fixture-owner', rootPath: dataRoot, legacy: false, status: 'active',
      permissions: { canRead: true, canWrite: true, canDelete: true, canCreatePublicLinks: true, canManageWorkspace: true, canRunAgent: true } };
    const scope = { documentId: `collab-doc-${randomUUID()}`, workspaceId: workspace.workspaceId, organizationId: null,
      path: 'post-migration.md', representation: 'tiptap_blocks' as const, lifecycleGeneration: 2, schemaVersion: 1 };
    const doc = createRichMarkdownYDoc('# Native document\n\nAuthoritative paragraph.', 'tiptap_blocks');
    try {
      await seed.query(`INSERT INTO collaboration_documents(id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,'personal',NULL,$3,'yjs',0,'initialized','active',100,100)`,
      [scope.documentId, scope.workspaceId, scope.path]);
      await seed.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,
        lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
        VALUES($1,$2,NULL,$3,'tiptap_blocks',2,1,$4,$5,2,100,0,'lf',0,0,'active')`,
      [scope.documentId, scope.workspaceId, scope.path, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc))]);
    } finally { doc.destroy(); }
    const before = (await seed.query(`SELECT yjs_state,state_vector,document_sequence,lifecycle_generation,representation
      FROM collaboration_yjs_states WHERE document_id=$1`, [scope.documentId])).rows[0];
    const ownerClient = await fresh(); owner = await createCollaborationRoomOwnerSession(ownerClient);
    const key = collaborationAdmissionLockKey(workspace.workspaceId);
    const currentRow = async () => (await seed.query('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [scope.documentId])).rows[0];
    const nativeUnchanged = async () => assert.deepEqual((await seed.query(`SELECT yjs_state,state_vector,document_sequence,lifecycle_generation,representation
      FROM collaboration_yjs_states WHERE document_id=$1`, [scope.documentId])).rows[0], before);
    const rejected = (code: string) => (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === code;
    const admissionRequest = () => {
      const actionPayloadText = JSON.stringify({ kind: 'owned-native-admission-regression' });
      return { requestId: randomUUID(), actorId: 'fixture-owner', action: 'compact' as const, actionPayloadText,
        actionDigest: collaborationAdmissionActionDigest('compact', actionPayloadText),
        scopes: [{ workspaceId: scope.workspaceId, organizationId: null, path: scope.path, kind: 'exact' as const }],
        expectedDocuments: [{ ...scope, status: 'active' as const }] };
    };
    const admission = createCollaborationAdmissionService({ openConnection });

    phase = 'exclusive physical publication admission refuses a new room claim';
    const physicalHolder = await fresh();
    await physicalHolder.query('BEGIN');
    try {
      await physicalHolder.query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
      const row = await currentRow();
      await assert.rejects(owner.acquire(scope), rejected('ROOM_OWNER_BUSY'));
      assert.deepEqual(await currentRow(), row); await owner.probe();
    } finally { await physicalHolder.query('ROLLBACK'); }
    console.log('PASS exclusive physical admission rejects without taking ownership or altering native state.');

    phase = 'actual lifecycle lease and exact scoped grant remain distinct';
    let resumeRetained!: () => void;
    const retainedGate = new Promise<void>(resolve => { resumeRetained = resolve; });
    let retainedClaim: Promise<unknown> | undefined;
    try {
      await withWorkspaceFileLifecycleGuard({ workspaceId: scope.workspaceId, paths: [scope.path] }, async () => {
        const row = await currentRow();
        await assert.rejects(owner!.acquire(scope), rejected('ROOM_OWNER_BUSY'));
        assert.deepEqual(await currentRow(), row);
        await withWorkspaceFileLifecycleCollaborationWrite(scope, async () => {
          const fence = await owner!.acquire(scope);
          owner!.assertActive(fence); await nativeUnchanged(); await owner!.release(fence);
          retainedClaim = retainedGate.then(() => owner!.acquire(scope));
          void retainedClaim.catch(() => undefined);
        });
        // The grant has ended while the genuine outer exclusive lifecycle lease is still held.
        const afterGrant = await currentRow(); resumeRetained();
        assert(retainedClaim); await assert.rejects(retainedClaim, rejected('ROOM_OWNER_BUSY'));
        assert.deepEqual(await currentRow(), afterGrant); await nativeUnchanged(); await owner!.probe();
      }, openConnection);
    } finally { resumeRetained(); }
    console.log('PASS real lifecycle lease blocks ordinary claims; genuine scoped grant works only during its callback.');

    phase = 'committed active reservation refuses ownership';
    const reservedRequest = admissionRequest();
    const reservation = await admission.reserve(reservedRequest);
    try {
      assert.equal(reservation.status, 'reserved'); assert.equal(reservation.targets.length, 1);
      const row = await currentRow();
      await assert.rejects(owner.acquire(scope), rejected('ROOM_OWNER_BUSY'));
      assert.deepEqual(await currentRow(), row); await owner.probe();
      assert.equal((await seed.query(`SELECT active FROM collaboration_admission_targets WHERE request_id=$1 AND document_id=$2`,
        [reservedRequest.requestId, scope.documentId])).rows[0].active, true);
    } finally { assert.equal((await admission.cancel(reservedRequest, reservation.revision)).status, 'cancelled'); }
    console.log('PASS actual committed reservation rejects without epoch advance, takeover or native mutation.');

    phase = 'foreign dedicated room owner cannot be taken over';
    const foreign = await createCollaborationRoomOwnerSession(await fresh());
    try {
      const fence = await foreign.acquire(scope), row = await currentRow();
      await assert.rejects(owner.acquire(scope), rejected('ROOM_OWNER_BUSY'));
      assert.deepEqual(await currentRow(), row); foreign.assertActive(fence);
      assert.equal(row.room_owner_token, fence.token); assert.equal(row.room_owner_backend_pid, fence.backendPid);
      await nativeUnchanged(); await foreign.release(fence); await owner.probe();
    } finally { await foreign.close(); }
    console.log('PASS actual foreign document lock and owner row remain untouched until their exact holder releases.');

    phase = 'stale native identity cannot acquire or leak a document lock';
    const identityChanges = [['path', 'replacement.md'], ['lifecycle_generation', 3], ['organization_id', randomUUID()],
      ['representation', 'plain_text'], ['schema_version', 2], ['status', 'archived']] as const;
    for (const [column, value] of identityChanges) {
      const original = await currentRow();
      await seed.query(`UPDATE collaboration_yjs_states SET ${column}=$2 WHERE document_id=$1`, [scope.documentId, value]);
      try {
        const changed = await currentRow();
        await assert.rejects(owner.acquire(scope), rejected('ROOM_OWNER_SCOPE_CHANGED'));
        assert.deepEqual(await currentRow(), changed); await owner.probe();
      } finally {
        await seed.query(`UPDATE collaboration_yjs_states SET ${column}=$2 WHERE document_id=$1`, [scope.documentId, original[column]]);
      }
      // A fresh actual claim after each rejected identity proves its acquired document lock was released.
      const fence = await owner.acquire(scope); owner.assertActive(fence); await owner.release(fence); await nativeUnchanged();
    }
    console.log('PASS path, generation, organization, representation, schema and archived-state drift stay fail closed.');

    phase = 'loss of an owned backend revokes old fences before a fresh legitimate claim';
    const lostClient = await fresh(), lost = await createCollaborationRoomOwnerSession(lostClient);
    try {
      const fence = await lost.acquire(scope), row = await currentRow();
      await lostClient.end(); clients.delete(lostClient);
      assert.throws(() => lost.assertActive(fence), rejected('ROOM_OWNER_LOST'));
      await assert.rejects(lost.acquire(scope), rejected('ROOM_OWNER_LOST'));
      assert.deepEqual(await currentRow(), row);
      const replacement = await owner.acquire(scope);
      assert.equal(replacement.epoch, fence.epoch + 1); assert.notEqual(replacement.token, fence.token);
      owner.assertActive(replacement); await nativeUnchanged(); await owner.release(replacement);
    } finally { await lost.close(); }
    console.log('PASS actual backend loss invalidates its lifetime; only a fresh verified owner advances the epoch.');

    phase = 'actual claim commit serializes a subsequent reservation';
    const claimClient = await fresh();
    let enteredCommit!: () => void, releaseCommit!: () => void, gateCommit = true;
    const entered = new Promise<void>(resolve => { enteredCommit = resolve; });
    const release = new Promise<void>(resolve => { releaseCommit = resolve; });
    const bounded = async <T>(promise: Promise<T>): Promise<T> => {
      let timeout: NodeJS.Timeout | undefined;
      try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Owned COMMIT barrier or cleanup did not settle.')), 5000);
      })]); } finally { if (timeout) clearTimeout(timeout); }
    };
    const claimTransport = { query: async (sql: string, values?: unknown[]) => {
      if (gateCommit && sql.trim() === 'COMMIT') { gateCommit = false; enteredCommit(); await release; }
      return claimClient.query(sql, values);
    }, on: claimClient.on.bind(claimClient), end: claimClient.end.bind(claimClient) } as Pick<Client, 'query' | 'on' | 'end'>;
    const racing = await createCollaborationRoomOwnerSession(claimTransport);
    let claim: ReturnType<typeof racing.acquire> | undefined;
    let pendingReserve: ReturnType<typeof admission.reserve> | undefined;
    try {
      const previous = await currentRow(); claim = racing.acquire(scope); void claim.catch(() => undefined);
      await bounded(Promise.race([entered, claim.then(() => { throw new Error('The real claim skipped its expected COMMIT barrier.'); })]));
      const nextRequest = admissionRequest(); pendingReserve = admission.reserve(nextRequest); void pendingReserve.catch(() => undefined);
      const observer = await fresh(); await observer.query('BEGIN');
      try {
        assert.equal((await observer.query('SELECT pg_try_advisory_xact_lock($1::bigint) AS locked', [key])).rows[0].locked, false,
          'The real claim admission guard still prevents exclusive reservation publication before COMMIT.');
        assert.equal((await currentRow()).room_owner_epoch, previous.room_owner_epoch);
      } finally { await observer.query('ROLLBACK'); }
      releaseCommit();
      const fence = await claim, next = await pendingReserve;
      assert.equal(next.status, 'reserved'); assert.equal(next.targets.length, 1);
      assert.equal(next.targets[0].ownerEpoch, fence.epoch); assert.equal(next.targets[0].ownerToken, fence.token);
      assert.equal(next.targets[0].ownerBackendPid, fence.backendPid); racing.assertActive(fence);
      await nativeUnchanged(); await racing.release(fence);
      assert.equal((await admission.cancel(nextRequest, next.revision)).status, 'cancelled');
    } finally {
      releaseCommit(); await racing.close();
      await bounded(Promise.allSettled([claim, pendingReserve].filter(Boolean)));
    }
    console.log('PASS actual claim-to-reservation ordering captures the committed owner, preserving native bytes and exact release.');

    phase = 'ordinary native writers retain their exclusive admission policy under a real reader';
    await withNativeWorkspaceFileRead({ workspace, path: scope.path, mode: 'metadata' }, async native => {
      assert.equal(native?.documentId, scope.documentId);
      const writer = await fresh(); await writer.query('BEGIN');
      try {
        await assert.rejects(tryLockFileLifecycleCollaborationWriterAdmission(async (sql, values) =>
          (await writer.query(sql, values)).rows, scope), rejected('ADMISSION_CONFLICT'));
        await nativeUnchanged();
      } finally { await writer.query('ROLLBACK'); }
    }, { openConnection });
    console.log('PASS the unchanged direct writer helper does not inherit the reader-compatible room-claim admission.');

    phase = 'positive actual metadata reader must coexist with actual owner acquisition';
    await withNativeWorkspaceFileRead({ workspace, path: scope.path, mode: 'metadata' }, async native => {
      assert.equal(native?.documentId, scope.documentId); assert.equal(native.lifecycleGeneration, 2); assert.equal(native.documentSequence, 2);
      const observer = await fresh();
      const held = (await observer.query(`SELECT count(*)::integer AS count FROM pg_locks WHERE locktype='advisory'
        AND database=$1::oid AND objsubid=1 AND mode='ShareLock' AND granted
        AND classid=((($2::bigint >> 32) & 4294967295)::oid) AND objid=(($2::bigint & 4294967295)::oid)`,
      [realm.oid, collaborationAdmissionLockKey(workspace.workspaceId)])).rows[0];
      assert.equal(held.count, 1, 'The real reader still holds its actual workspace shared admission lock.');
      const fence = await owner!.acquire(scope);
      owner!.assertActive(fence); assert.deepEqual(fence.scope, scope);
      assert.deepEqual((await seed.query(`SELECT yjs_state,state_vector,document_sequence,lifecycle_generation,representation
        FROM collaboration_yjs_states WHERE document_id=$1`, [scope.documentId])).rows[0], before);
      await owner!.release(fence);
    }, { openConnection });
    console.log('PASS actual native metadata read and room owner claim coexist without changing native bytes or identity.');
  } finally {
    globalThis.fetch = originalFetch;
    try { await owner?.close(); }
    finally {
      try {
        const closed = await Promise.allSettled([...clients].map(client => client.end()));
        assert(closed.every(result => result.status === 'fulfilled'), 'Every owned client must finish cleanup.');
      }
      finally {
        try {
          if (created) { await control.query(`DROP SCHEMA "${schema}" CASCADE`);
            assert.equal((await control.query('SELECT to_regnamespace($1) IS NULL AS removed', [schema])).rows[0].removed, true); }
        } finally {
          try { await control.end(); }
          finally {
            if (dataRoot) await rm(dataRoot, { recursive: true, force: true });
            for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]; Object.assign(process.env, previousEnv);
          }
        }
      }
    }
  }
}
void main().catch(error => { console.error('Native read/owner admission fixture failed:', { phase,
  code: error && typeof error === 'object' ? Reflect.get(error, 'code') ?? 'unclassified' : 'unclassified' }); process.exitCode = 1; });
