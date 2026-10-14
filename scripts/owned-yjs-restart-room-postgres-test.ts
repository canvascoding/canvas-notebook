/** Genuine PG18 evidence for the restart room reader. No browser or host is started. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client, types } from 'pg';
import { privateBytes } from './lib/owned-yjs-authority-qa';
import type { OwnedRestartRoomEvidence, OwnedRestartRoomInput } from './lib/owned-yjs-restart-room-read';
import type { CollaborationRoomOwnerScope } from '../app/lib/collaboration/room-owner';

type OwnedClient = { client: Client; pid: number; closed: boolean };
const tables = ['collaboration_documents', 'file_collaboration_lineages', 'collaboration_yjs_states',
  'collaboration_room_release_receipts', 'collaboration_admission_requests', 'collaboration_admission_scopes',
  'collaboration_admission_targets'] as const;
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
let stage = 'private configuration';

async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  const connectionString = parse(await privateBytes('/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert(!url.search && !url.hash);
  const nonce = randomUUID().replaceAll('-', ''), schema = `owned_restart_room_${nonce}`, prefix = `owned-restart-room-${nonce}`;
  assert.match(schema, /^owned_restart_room_[a-f0-9]{32}$/u);
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, application_name: `${prefix}-control`, connectionTimeoutMillis: 5_000,
    options: '-c statement_timeout=15000 -c lock_timeout=1000' });
  const clients: OwnedClient[] = [];
  let schemaCreated = false, schemaOid: string | undefined, dataRoot: string | undefined, completed = 0;
  let identity: { name: string; oid: string; owner: string; role: string } | undefined;
  const currentIdentity = async () => (await control.query(`SELECT current_database() AS name,d.oid::text AS oid,
    pg_get_userbyid(d.datdba) AS owner,current_user AS role,current_setting('server_version_num') AS version
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  const assertOriginalTarget = async () => {
    const current = await currentIdentity();
    assert(identity); for (const key of ['name', 'oid', 'owner', 'role'] as const) assert.equal(current[key], identity[key]);
    assert.equal(Math.floor(Number(current.version) / 10000), 18);
  };
  const end = async (owned: OwnedClient) => {
    if (owned.closed) return;
    await owned.client.end(); owned.closed = true;
  };
  const closeAll = async () => {
    const outcomes = await Promise.allSettled(clients.map(end));
    assert(outcomes.every(outcome => outcome.status === 'fulfilled'), 'An owned PostgreSQL session did not close.');
  };
  try {
    stage = 'actual target and own schema'; await control.connect();
    const found = await currentIdentity();
    assert.equal(found.name, 'canvas_notebook'); assert.equal(found.owner, found.role);
    assert.equal(found.role, decodeURIComponent(url.username)); assert.match(found.oid, /^\d+$/u);
    assert.equal(Math.floor(Number(found.version) / 10000), 18);
    identity = { name: found.name, oid: found.oid, owner: found.owner, role: found.role };
    assert.equal((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
    await assertOriginalTarget(); await control.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    const namespace = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
    assert.equal(namespace.owner, identity.role); assert.match(namespace.oid, /^\d+$/u); schemaOid = namespace.oid;
    dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-owned-restart-room-'));
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog`,
      CANVAS_DATABASE_PROVIDER: 'postgres', CANVAS_POSTGRES_MODE: 'external', CANVAS_DATABASE_MIGRATIONS_COMPLETED: 'true',
      CANVAS_POSTGRES_VECTOR_ENABLED: 'false', CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: randomUUID(),
      DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, BETTER_AUTH_BASE_URL: 'https://canvas.test' });
    globalThis.fetch = async () => { throw new Error('External access is prohibited in this isolated room reader fixture.'); };
    const connect = async (label: string): Promise<OwnedClient> => {
      const client = new Client({ connectionString, application_name: `${prefix}-${label}`, connectionTimeoutMillis: 5_000,
        options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=1000`,
        // App modules can configure global parsers later. This reader still receives real default INT8 strings.
        types: { getTypeParser: (oid: number, format?: 'text' | 'binary') => oid === types.builtins.INT8
          ? (value: string) => value : types.getTypeParser(oid, format) } });
      const owned = { client, pid: 0, closed: false }; clients.push(owned);
      await client.connect(); owned.pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      return owned;
    };
    const assertOwned = async (owned: OwnedClient) => {
      assert(!owned.closed && identity && schemaOid);
      const current = (await owned.client.query(`SELECT current_database() AS name,d.oid::text AS oid,current_user AS role,
        pg_get_userbyid(d.datdba) AS database_owner,current_schema() AS schema,current_setting('search_path') AS path,
        n.oid::text AS schema_oid,pg_get_userbyid(n.nspowner) AS schema_owner,pg_backend_pid() AS pid
        FROM pg_database d JOIN pg_namespace n ON n.nspname=current_schema() WHERE d.datname=current_database()`)).rows[0];
      assert.equal(current.name, identity.name); assert.equal(current.oid, identity.oid); assert.equal(current.role, identity.role);
      assert.equal(current.database_owner, identity.owner); assert.equal(current.schema, schema);
      assert.equal(current.path, `${schema},pg_catalog`); assert.equal(current.schema_oid, schemaOid);
      assert.equal(current.schema_owner, identity.role); assert.equal(current.pid, owned.pid);
    };
    const query = async (owned: OwnedClient, sql: string, values?: unknown[]) => {
      await assertOwned(owned); const result = await owned.client.query(sql, values); await assertOwned(owned); return result;
    };
    const writer = await connect('writer'), reader = await connect('reader'), holder = await connect('holder');
    const write = (sql: string, values?: unknown[]) => query(writer, sql, values);
    stage = 'owned requisite tables';
    await write(`CREATE TABLE collaboration_documents (id text NOT NULL,workspace_id text NOT NULL,organization_id text,
      path text NOT NULL,provider text NOT NULL,status text NOT NULL,state_version bigint NOT NULL,lineage_id text)`);
    await write(`CREATE TABLE file_collaboration_lineages (id text NOT NULL,workspace_id text NOT NULL,organization_id text,
      path text NOT NULL,status text NOT NULL)`);
    await write(`CREATE TABLE collaboration_yjs_states (document_id text PRIMARY KEY,workspace_id text NOT NULL,organization_id text,
      path text NOT NULL,representation text NOT NULL,lifecycle_generation bigint NOT NULL,schema_version bigint NOT NULL,
      yjs_state bytea NOT NULL,state_vector bytea NOT NULL,document_sequence bigint NOT NULL,persisted_at bigint NOT NULL,
      checkpointed_at bigint,checkpoint_sequence bigint NOT NULL,canonical_hash text,serialized_hash text,newline_style text NOT NULL,
      has_bom bigint NOT NULL,degraded bigint NOT NULL,status text NOT NULL,projection_error_code text,projection_error_phase text,
      projection_error_sequence bigint,projection_error_generation bigint,projection_error_permanent bigint NOT NULL,
      room_owner_epoch bigint NOT NULL,room_owner_token text,room_owner_backend_pid integer,room_owner_backend_start text)`);
    await write(`CREATE TABLE collaboration_room_release_receipts (release_id text NOT NULL,document_id text NOT NULL,
      workspace_id text NOT NULL,organization_id text,path text NOT NULL,representation text NOT NULL,lifecycle_generation bigint NOT NULL,
      schema_version bigint NOT NULL,owner_epoch bigint NOT NULL,owner_token text NOT NULL,owner_backend_pid bigint NOT NULL,
      owner_backend_start text NOT NULL,document_sequence bigint NOT NULL,persisted_update_hash text NOT NULL,
      persisted_vector_hash text NOT NULL,live_update_hash text NOT NULL,live_vector_hash text NOT NULL,created_at bigint NOT NULL)`);
    await write('CREATE TABLE collaboration_admission_requests (request_id text PRIMARY KEY,status text NOT NULL)');
    await write('CREATE TABLE collaboration_admission_scopes (request_id text NOT NULL,workspace_id text NOT NULL,path text NOT NULL,kind text NOT NULL)');
    await write('CREATE TABLE collaboration_admission_targets (request_id text NOT NULL,document_id text NOT NULL,active boolean NOT NULL)');

    // Target OID, private DATA, exact search_path, schema ownership and environment are bound before app imports.
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { createCollaborationRoomOwnerSession, lockIdentity } = await import('../app/lib/collaboration/room-owner');
    const { readOwnedRestartRoomOnConnection } = await import('./lib/owned-yjs-restart-room-read');
    const workspaceId = randomUUID();
    const documentIdFor = (negative: boolean): string => {
      for (let attempt = 0; attempt < 128; attempt++) {
        const value = randomUUID(); if (lockIdentity(value).key.startsWith('-') === negative) return value;
      }
      throw new Error('The isolated signed room lock fixture is unavailable.');
    };
    const fixture = async (name: string, run: () => Promise<void>) => {
      stage = name; await run(); console.log(`ok ${++completed} - ${name}`);
    };
    const persistentRows = async () => {
      const rows: Record<string, Array<Record<string, unknown>>> = {};
      for (const table of tables) rows[table] = (await write(`SELECT * FROM ${table}`)).rows;
      return rows;
    };
    const fingerprint = async () => {
      const rows = await persistentRows();
      return digest(JSON.stringify(tables.map(table => [table, rows[table].map(row => JSON.stringify(row)).sort()])));
    };
    const readerLocks = async () => {
      assert.equal((await write("SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1 AND locktype IN ('advisory','tuple')", [reader.pid])).rows[0].count, 0);
    };
    const observe = async (input: OwnedRestartRoomInput): Promise<OwnedRestartRoomEvidence> => {
      const before = await fingerprint(); await readerLocks();
      await query(reader, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const readonly = {
          query: async (sql: string, values?: unknown[]) => {
            assert.match(sql, /^\s*(?:SELECT|SHOW)\b/iu);
            assert(!/\bFOR\s+(?:UPDATE|SHARE)\b|\bpg_(?:try_)?advisory_(?:xact_)?lock\s*\(/iu.test(sql));
            assert.equal((await query(reader, 'SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
            return query(reader, sql, values);
          },
        };
        return await readOwnedRestartRoomOnConnection(readonly as unknown as Pick<Client, 'query'>, input);
      } finally {
        await query(reader, 'ROLLBACK'); await readerLocks();
        assert.equal(await fingerprint(), before, 'The room observation changed persisted fixture data.');
      }
    };
    const seed = async (nested: boolean, negative: boolean, organizationId: string | null) => {
      const documentId = documentIdFor(negative), filename = `owned-yjs-restart-${randomUUID()}.md`;
      const directory = `owned-yjs-restart-${randomUUID()}`, filePath = nested ? `${directory}/${filename}` : filename;
      const lineageId = randomUUID(), doc = createRichMarkdownYDoc('Durable native fixture.\n\nIndependent paragraph.', 'tiptap_blocks');
      let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
      const ownerConnection = await connect(`owner-${nested ? 'nested' : 'flat'}`);
      try {
        const yjsState = Buffer.from(Y.encodeStateAsUpdate(doc)), stateVector = Buffer.from(Y.encodeStateVector(doc));
        await write(`INSERT INTO collaboration_yjs_states (document_id,workspace_id,organization_id,path,representation,
          lifecycle_generation,schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpointed_at,checkpoint_sequence,
          canonical_hash,serialized_hash,newline_style,has_bom,degraded,status,projection_error_code,projection_error_phase,
          projection_error_sequence,projection_error_generation,projection_error_permanent,room_owner_epoch,
          room_owner_token,room_owner_backend_pid,room_owner_backend_start)
          VALUES($1,$2,$3,$4,'tiptap_blocks',1,1,$5,$6,2,$7,NULL,0,NULL,NULL,'lf',0,0,'active',NULL,NULL,NULL,NULL,0,0,NULL,NULL,NULL)`,
        [documentId, workspaceId, organizationId, filePath, yjsState, stateVector, Date.now()]);
        await write("INSERT INTO collaboration_documents VALUES($1,$2,$3,$4,'yjs','active',2,$5)", [documentId, workspaceId, organizationId, filePath, lineageId]);
        await write("INSERT INTO file_collaboration_lineages VALUES($1,$2,$3,$4,'active')", [lineageId, workspaceId, organizationId, filePath]);
        owner = await createCollaborationRoomOwnerSession({
          query: (sql: string, values?: unknown[]) => query(ownerConnection, sql, values),
          on: ownerConnection.client.on.bind(ownerConnection.client), end: () => end(ownerConnection),
        } as unknown as Pick<Client, 'query' | 'on' | 'end'>);
        const scope: CollaborationRoomOwnerScope = { documentId, workspaceId, organizationId, path: filePath,
          representation: 'tiptap_blocks', lifecycleGeneration: 1, schemaVersion: 1 };
        const fence = await owner.acquire(scope);
        const initialInput = { documentId, path: filePath, generation: 1, expectedWorkspaceId: workspaceId, expectedOwnerEpoch: fence.epoch };
        const active = await observe(initialInput);
        assert.match(active.scopeProof, /^[a-f0-9]{64}$/u);
        const input = { ...initialInput, expectedScopeProof: active.scopeProof };
        assert.equal(active.ownerTupleComplete, true); assert.equal(active.ownerTupleCleared, false);
        assert.equal(active.advisoryLockHeld, true); assert.equal(active.released, false);
        await owner.release(fence, { releaseId: randomUUID(), yjsState, stateVector }); await owner.close();
        const evidence = await observe(input); assert.equal(evidence.released, true);
        assert.equal(evidence.version.yjsSha256, digest(yjsState)); assert.equal(evidence.version.vectorSha256, digest(stateVector));
        assert.equal(evidence.version.sequence, 2); assert.match(evidence.version.stateProof, /^yjs-snapshot-sha256-v1:[a-f0-9]{64}$/u);
        return { input, evidence, directory, lineageId, scope };
      } finally { doc.destroy(); if (owner) await owner.close(); await end(ownerConnection); }
    };
    let flat!: Awaited<ReturnType<typeof seed>>, nested!: Awaited<ReturnType<typeof seed>>;
    await fixture('genuine owner release preserves BIGINT native proof and nullable organization', async () => {
      assert(process.env.CANVAS_ORGANIZATION_ID);
      flat = await seed(false, true, null); nested = await seed(true, false, randomUUID());
      assert(BigInt(lockIdentity(flat.input.documentId).key) < 0); assert(BigInt(lockIdentity(nested.input.documentId).key) >= 0);
      const row = (await write('SELECT * FROM collaboration_yjs_states WHERE document_id=$1', [flat.input.documentId])).rows[0];
      assert.equal(row.organization_id, null);
      for (const field of ['schema_version', 'lifecycle_generation', 'document_sequence', 'room_owner_epoch', 'has_bom', 'degraded'] as const) assert.equal(typeof row[field], 'string');
      assert.equal(row.has_bom, '0'); assert.equal(row.degraded, '0');
    });
    const baseline = await persistentRows();
    const reset = async () => {
      for (const table of [...tables].reverse()) await write(`DELETE FROM ${table}`);
      for (const table of tables) for (const row of baseline[table]) {
        const columns = Object.keys(row); assert(columns.every(column => /^[a-z_]+$/u.test(column)));
        await write(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`, Object.values(row));
      }
    };
    const changed = async (mutate: () => Promise<unknown>, verify: () => Promise<void>) => {
      await reset(); try { await mutate(); await verify(); } finally { await reset(); }
    };
    const rejects = async (input: OwnedRestartRoomInput = flat.input) => { await assert.rejects(() => observe(input)); };
    const replace = async (table: typeof tables[number], column: string, value: unknown, idColumn: string, id: string) => {
      assert(/^[a-z_]+$/u.test(column) && /^[a-z_]+$/u.test(idColumn));
      await write(`UPDATE ${table} SET ${column}=$1 WHERE ${idColumn}=$2`, [value, id]);
    };
    const state = (column: string, value: unknown) => replace('collaboration_yjs_states', column, value, 'document_id', flat.input.documentId);
    const registry = (column: string, value: unknown) => replace('collaboration_documents', column, value, 'id', flat.input.documentId);
    const receipt = (column: string, value: unknown) => replace('collaboration_room_release_receipts', column, value, 'document_id', flat.input.documentId);
    await fixture('exact advisory locks deny both signed key domains without reader lock acquisition', async () => {
      for (const target of [flat, nested]) {
        const lock = lockIdentity(target.input.documentId);
        assert.equal((await query(holder, 'SELECT pg_try_advisory_lock($1::bigint) AS locked', [lock.key])).rows[0].locked, true);
        try {
          const observed = await observe(target.input);
          assert.equal(observed.releaseReceiptValid, true); assert.equal(observed.ownerTupleCleared, true);
          assert.equal(observed.advisoryLockHeld, true); assert.equal(observed.released, false);
          assert.equal((await write("SELECT count(*)::int AS count FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted", [holder.pid])).rows[0].count, 1);
        } finally { assert.equal((await query(holder, 'SELECT pg_advisory_unlock($1::bigint) AS unlocked', [lock.key])).rows[0].unlocked, true); }
        assert.equal((await observe(target.input)).released, true);
      }
    });
    await fixture('complete and every partial retained owner tuple prevent release', async () => {
      const stored = baseline.collaboration_room_release_receipts.find(row => row.document_id === flat.input.documentId)!;
      const values = [stored.owner_token, Number(stored.owner_backend_pid), stored.owner_backend_start];
      const fields = ['room_owner_token', 'room_owner_backend_pid', 'room_owner_backend_start'];
      for (let mask = 1; mask <= 7; mask++) await changed(async () => {
        for (let index = 0; index < fields.length; index++) await state(fields[index], mask & (1 << index) ? values[index] : null);
      }, async () => {
        const observed = await observe(flat.input); assert.equal(observed.ownerTupleCleared, false);
        assert.equal(observed.ownerTupleComplete, mask === 7); assert.equal(observed.releaseReceiptValid, false); assert.equal(observed.released, false);
      });
    });
    await fixture('missing foreign and old epoch receipts cannot prove release', async () => {
      for (const mutate of [
        () => write('DELETE FROM collaboration_room_release_receipts WHERE document_id=$1', [flat.input.documentId]),
        () => receipt('document_id', randomUUID()), () => receipt('owner_epoch', 0),
      ]) await changed(mutate, async () => {
        const observed = await observe(flat.input); assert.equal(observed.releaseReceiptValid, false); assert.equal(observed.released, false);
      });
    });
    await fixture('malformed and foreign current receipts fail closed', async () => {
      for (const [column, value] of [
        ['release_id', 'malformed'], ['workspace_id', randomUUID()], ['organization_id', randomUUID()],
        ['path', `owned-yjs-restart-${randomUUID()}.md`], ['representation', 'plain_text'], ['lifecycle_generation', 2],
        ['schema_version', 2], ['owner_token', ''], ['owner_backend_pid', 0], ['owner_backend_start', ''],
        ['document_sequence', 3], ['persisted_update_hash', '0'.repeat(64)], ['persisted_vector_hash', '0'.repeat(64)],
        ['live_update_hash', 'malformed'], ['live_vector_hash', 'malformed'],
      ] as const) await changed(() => receipt(column, value), () => rejects());
      await changed(() => write(`INSERT INTO collaboration_room_release_receipts SELECT * FROM collaboration_room_release_receipts
        WHERE document_id=$1`, [flat.input.documentId]), () => rejects());
    });
    await fixture('observed epoch is retained across actual replacement ownership', async () => {
      await rejects({ ...flat.input, expectedOwnerEpoch: flat.input.expectedOwnerEpoch + 1 });
      const replacement = await connect('replacement'); let owner: Awaited<ReturnType<typeof createCollaborationRoomOwnerSession>> | undefined;
      try {
        owner = await createCollaborationRoomOwnerSession({ query: (sql: string, values?: unknown[]) => query(replacement, sql, values),
          on: replacement.client.on.bind(replacement.client), end: () => end(replacement),
        } as unknown as Pick<Client, 'query' | 'on' | 'end'>);
        const fence = await owner.acquire(flat.scope);
        const row = (await write('SELECT yjs_state,state_vector FROM collaboration_yjs_states WHERE document_id=$1', [flat.input.documentId])).rows[0];
        await owner.release(fence, { releaseId: randomUUID(), yjsState: row.yjs_state, stateVector: row.state_vector }); await owner.close();
        assert.equal(fence.epoch, flat.input.expectedOwnerEpoch + 1); await rejects();
        assert.equal((await observe({ ...flat.input, expectedOwnerEpoch: fence.epoch })).released, true);
      } finally { if (owner) await owner.close(); await end(replacement); await reset(); }
    });
    await fixture('registry state and lineage scope corruption never gain authority', async () => {
      for (const mutate of [
        () => state('workspace_id', randomUUID()), () => registry('workspace_id', randomUUID()),
        () => state('organization_id', randomUUID()), () => registry('organization_id', randomUUID()),
        () => state('path', `owned-yjs-restart-${randomUUID()}.md`), () => registry('path', `owned-yjs-restart-${randomUUID()}.md`),
        () => state('status', 'archived'), () => registry('status', 'archived'), () => registry('provider', 'other'),
        () => state('representation', 'plain_text'), () => state('schema_version', 2), () => state('lifecycle_generation', 2),
        () => state('lifecycle_generation', 0), () => state('room_owner_epoch', 0),
        () => registry('state_version', 3), () => registry('state_version', -1), () => registry('lineage_id', null),
        () => replace('file_collaboration_lineages', 'workspace_id', randomUUID(), 'id', flat.lineageId),
        () => replace('file_collaboration_lineages', 'organization_id', randomUUID(), 'id', flat.lineageId),
        () => replace('file_collaboration_lineages', 'path', `owned-yjs-restart-${randomUUID()}.md`, 'id', flat.lineageId),
        () => replace('file_collaboration_lineages', 'status', 'archived', 'id', flat.lineageId),
      ]) await changed(mutate, () => rejects());
      await rejects({ ...flat.input, expectedWorkspaceId: randomUUID() });
      await changed(() => state('lifecycle_generation', 2), () => rejects({ ...flat.input, generation: 2 }));
    });
    await fixture('orphan and duplicate active paths or lineage rows are rejected', async () => {
      for (const mutate of [
        () => write('DELETE FROM collaboration_documents WHERE id=$1', [flat.input.documentId]),
        () => write('INSERT INTO collaboration_documents SELECT * FROM collaboration_documents WHERE id=$1', [flat.input.documentId]),
        () => write(`INSERT INTO collaboration_documents SELECT $1,workspace_id,organization_id,path,provider,status,state_version,lineage_id
          FROM collaboration_documents WHERE id=$2`, [randomUUID(), flat.input.documentId]),
        () => write('INSERT INTO file_collaboration_lineages SELECT * FROM file_collaboration_lineages WHERE id=$1', [flat.lineageId]),
        () => write('DELETE FROM file_collaboration_lineages WHERE id=$1', [flat.lineageId]),
      ]) await changed(mutate, () => rejects());
    });
    await fixture('frozen scope proof rejects coherent workspace organization path and lineage adoption', async () => {
      for (const column of ['workspace_id', 'organization_id', 'path', 'lineage_id'] as const) {
        const next = column === 'path' ? `owned-yjs-restart-${randomUUID()}.md` : randomUUID();
        const adopted = { ...flat.input, expectedScopeProof: undefined,
          ...(column === 'workspace_id' ? { expectedWorkspaceId: next } : {}),
          ...(column === 'path' ? { path: next } : {}) };
        await changed(async () => {
          if (column === 'lineage_id') {
            await registry(column, next); await replace('file_collaboration_lineages', 'id', next, 'id', flat.lineageId);
          } else {
            await registry(column, next); await state(column, next); await receipt(column, next);
            await replace('file_collaboration_lineages', column, next, 'id', flat.lineageId);
          }
        }, async () => {
          // A coherent new scope has the very same native version and would pass an unfrozen reader.
          const current = await observe(adopted); assert.equal(current.released, true);
          assert.deepEqual(current.version, flat.evidence.version); assert.notEqual(current.scopeProof, flat.evidence.scopeProof);
          await rejects({ ...adopted, expectedScopeProof: flat.input.expectedScopeProof });
        });
      }
      await rejects({ ...flat.input, expectedScopeProof: 'malformed' });
      await rejects({ ...flat.input, expectedScopeProof: '0'.repeat(64) });
    });
    const admission = async (target: typeof flat, scopePath: string, kind: string, status: string, otherWorkspace = false) => {
      const requestId = randomUUID(); await write('INSERT INTO collaboration_admission_requests VALUES($1,$2)', [requestId, status]);
      await write('INSERT INTO collaboration_admission_scopes VALUES($1,$2,$3,$4)', [requestId, otherWorkspace ? randomUUID() : target.scope.workspaceId, scopePath, kind]);
    };
    await fixture('exact descendant ancestor and root pending scopes block release', async () => {
      for (const [scopePath, kind] of [[nested.input.path, 'exact'], [`${nested.input.path}/child`, 'exact'],
        [nested.directory, 'subtree'], ['', 'subtree']] as const) {
        for (const status of ['reserved', 'draining', 'released', 'applying', 'failed']) {
          await changed(() => admission(nested, scopePath, kind, status), async () => {
            const observed = await observe(nested.input); assert.equal(observed.releaseReceiptValid, true);
            assert.equal(observed.admissionPending, true); assert.equal(observed.released, false);
          });
        }
      }
    });
    await fixture('terminal adjacent sibling and foreign workspace admissions permit release', async () => {
      for (const status of ['committed', 'cancelled']) await changed(() => admission(nested, '', 'subtree', status), async () => {
        const observed = await observe(nested.input); assert.equal(observed.admissionPending, false); assert.equal(observed.released, true);
      });
      for (const [scopePath, kind, otherWorkspace] of [[`${nested.directory}-neighbor`, 'subtree', false],
        [`${nested.input.path}-neighbor`, 'exact', false], [nested.directory, 'exact', false], ['', 'subtree', true]] as const) {
        await changed(() => admission(nested, scopePath, kind, 'reserved', otherWorkspace), async () => {
          const observed = await observe(nested.input); assert.equal(observed.admissionPending, false); assert.equal(observed.released, true);
        });
      }
    });
    await fixture('native bytes vector and sequence drift invalidate the durable release proof', async () => {
      await changed(async () => {
        const doc = createRichMarkdownYDoc('A different durable native document.', 'tiptap_blocks');
        try { await state('yjs_state', Buffer.from(Y.encodeStateAsUpdate(doc))); await state('state_vector', Buffer.from(Y.encodeStateVector(doc))); }
        finally { doc.destroy(); }
      }, () => rejects());
      await changed(() => state('state_vector', Buffer.from([0])), () => rejects());
      await changed(async () => {
        const row = baseline.collaboration_yjs_states.find(row => row.document_id === flat.input.documentId)!;
        await state('yjs_state', Buffer.concat([row.yjs_state as Buffer, Buffer.from([0])]));
      }, () => rejects());
      await changed(() => state('document_sequence', 3), () => rejects());
      await changed(() => state('document_sequence', '9007199254740992'), () => rejects());
    });
    await fixture('reader rejects writable transactions without changing durable native state', async () => {
      const before = await fingerprint(); await query(reader, 'BEGIN');
      try { await assert.rejects(() => readOwnedRestartRoomOnConnection(reader.client, flat.input)); }
      finally { await query(reader, 'ROLLBACK'); }
      await readerLocks(); assert.equal(await fingerprint(), before);
      assert.deepEqual((await observe(flat.input)).version, flat.evidence.version);
      assert.deepEqual((await observe(nested.input)).version, nested.evidence.version);
    });
    await closeAll();
    await assertOriginalTarget();
    assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE $1', [`${prefix}%`])).rows[0].count, 1);
    assert.equal((await control.query('SELECT count(*)::int AS count FROM pg_locks WHERE pid=ANY($1::int[])', [clients.map(owned => owned.pid).filter(Boolean)])).rows[0].count, 0);
    console.log(`Passed ${completed} real PostgreSQL room proof groups; this does not certify a browser restart outcome.`);
  } finally {
    globalThis.fetch = originalFetch;
    try { await closeAll(); }
    finally {
      try {
        if (schemaCreated) {
          await assertOriginalTarget();
          const current = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
          assert.equal(current?.oid, schemaOid); assert.equal(current?.owner, identity?.role);
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          assert.equal((await control.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rowCount, 0);
        }
      } finally {
        try { await control.end(); }
        finally {
          try { if (dataRoot) await rm(dataRoot, { recursive: true, force: true }); }
          finally {
            for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
            Object.assign(process.env, environment);
          }
        }
      }
    }
  }
}

void main().catch(() => { console.error(`Owned restart room PostgreSQL fixture failed during ${stage}.`); process.exitCode = 1; });
