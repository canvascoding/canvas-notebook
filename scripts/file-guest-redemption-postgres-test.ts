import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';
import type { WorkspaceFileMetadataTarget } from '../app/lib/files/workspace-file-metadata-contract';
import type { CollaborationTicketClaims } from '../app/lib/collaboration/types';

type Row = Record<string, unknown>;
type QueryObservation = { client: Client; sql: string; values: unknown[]; args: unknown[]; run: () => unknown };
type Delivery = (result: unknown) => Promise<void> | void;

/** Only delivery timing/transport acknowledgement changes; SQL and real results do not. */
function afterRealQuery(observation: QueryObservation, after: Delivery): unknown {
  const { client, args } = observation;
  const callbackIndex = args.length - 1;
  if (typeof args[callbackIndex] === 'function') {
    const callback = args[callbackIndex] as (...values: unknown[]) => void;
    const forwarded = [...args];
    forwarded[callbackIndex] = (error: unknown, result: unknown) => {
      if (error) { callback(error, result); return; }
      Promise.resolve().then(() => after(result)).then(() => callback(null, result), error => callback(error));
    };
    return Reflect.apply(originalClientQuery, client, forwarded);
  }
  return Promise.resolve(observation.run()).then(async result => { await after(result); return result; });
}

const originalClientQuery = Client.prototype.query;
async function observeQueries<T>(observe: (query: QueryObservation) => unknown, operation: () => Promise<T>): Promise<T> {
  assert.equal(Client.prototype.query, originalClientQuery, 'Query observers cannot overlap.');
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    const input = args[0];
    const sql = (typeof input === 'string' ? input : input && typeof input === 'object' ? String(Reflect.get(input, 'text') ?? '') : '').trim();
    const values = Array.isArray(args[1]) ? args[1] : input && typeof input === 'object' && Array.isArray(Reflect.get(input, 'values'))
      ? Reflect.get(input, 'values') as unknown[] : [];
    return observe({ client: this, sql, values, args, run: () => Reflect.apply(originalClientQuery, this, args) });
  } as typeof Client.prototype.query;
  try { return await operation(); }
  finally { Client.prototype.query = originalClientQuery; }
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 8000); })]);
  } finally { if (timeout) clearTimeout(timeout); }
}

async function waitFor(check: () => Promise<boolean>, message: string): Promise<void> {
  const until = Date.now() + 5000;
  while (!await check()) {
    assert(Date.now() < until, message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration';
let completed = false, passedFamilies = 0;
process.once('beforeExit', () => {
  if (!completed) { console.error('Guest service fixture exited before completion.', { stage }); process.exitCode = 1; }
});
async function main(): Promise<void> {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL;
  assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol));
  assert(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, '');
  const schema = `guest_redemption_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^guest_redemption_[a-f0-9]{32}$/u);
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'canvas-guest-redemption-'));
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000, options: '-c statement_timeout=15000' });
  let admin: Client | undefined, created = false, cases = 0;
  let closeRuntime: (() => Promise<void>) | undefined;
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    Object.assign(process.env, {
      DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot,
      CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`, BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'),
      CANVAS_COLLABORATION_TICKET_SECRET: crypto.randomBytes(32).toString('hex'),
      BETTER_AUTH_BASE_URL: 'http://localhost', BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'redemption-org', CANVAS_DEPLOYMENT_MODE: 'team',
      CANVAS_TEAM_FEATURES_ENABLED: 'true', CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production',
      CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test',
    });
    delete process.env.BOOTSTRAP_ADMIN_EMAIL; delete process.env.NEXT_PHASE;
    delete process.env.CANVAS_LICENSE_TEST_PUBLIC_KEY; delete process.env.CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS;
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = {
      protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'redemption-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      deploymentMode: 'community', databaseProvider: 'postgres', vectorProvider: 'none', postgresRequired: true,
      organizationId: 'redemption-org', capabilities: { multiUser: true, teamWorkspace: true, liveCollaboration: true, vectorSearch: false },
      features: { multiUser: true, teamWorkspace: true, liveCollaboration: true },
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600,
    };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    let networkCalls = 0;
    globalThis.fetch = async () => { networkCalls++; throw new Error('No external issuer or email is permitted in the owned Guest fixture.'); };
    admin = new Client({ connectionString, connectionTimeoutMillis: 5000,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-redemption-fixture` });
    admin.on('error', () => undefined); await admin.connect();
    const fixture = admin;
    stage = 'actual original owned-schema global DDL';
    console.log('Owned Guest redemption fixture:', JSON.stringify({ pid: process.pid, schema, dataRoot }));
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await fixture.query("SELECT current_schema() AS name,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.name, schema); assert.deepEqual(before.path.split(',').map((part: string) => part.trim()), [schema, 'pg_catalog']);
      const result = await fixture.query(sql, values);
      assert.equal((await fixture.query('SELECT current_schema() AS name')).rows[0].name, schema);
      return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const now = Date.now();
    await fixture.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@redemption.test',1,'admin',0,$1,$1)`, [now]);
    await fixture.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('redemption-org','owner','team',1,100,100)`);
    await fixture.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
      VALUES('redemption-org','owner','owner','active',1,1,100,100)`);
    await fixture.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','redemption-org','owner@redemption.test','owner','owner','active',100,100,100,100)`);
    await fixture.query(`INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('redemption-org',100,100)`);
    await fixture.query(`INSERT INTO canvas_workspaces(id,organization_id,type,display_name,root_relative_path,status,created_at,updated_at)
      VALUES('redemption-space','redemption-org','organization','Redemption','organizations/redemption-org/shared','active',100,100)`);
    const database = await import('../app/lib/db');
    closeRuntime = database.closeDatabaseConnections;
    const runtime = database.getPostgresRuntimeQueryable(); assert(runtime);
    assert.equal((await runtime.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const { requireTeamRuntimeLicense } = await import('../app/lib/license/entitlements');
    const license = await requireTeamRuntimeLicense();
    assert.equal(license.licensed, true); assert.equal(license.edition, 'team');
    assert.equal(license.databaseProvider, 'postgres'); assert.equal(license.capabilities.liveCollaboration, true);
    const memberToken = crypto.randomBytes(32).toString('hex');
    await fixture.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
      VALUES('guest-fixture-owner-session',$1,'owner',$2,$3,$3)`, [memberToken, Date.now() + 7 * 86400000, Date.now()]);
    const memberRequest = () => new NextRequest('http://localhost/api/files/guests', {
      headers: { authorization: `Bearer ${memberToken}`, 'x-canvas-workspace-id': 'redemption-space' },
    });
    const { auth } = await import('../app/lib/auth');
    assert.equal((await auth.api.getSession({ headers: memberRequest().headers }))?.session.id, 'guest-fixture-owner-session');
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'owner', role: 'admin' }, 'redemption-space');
    assert(workspace); assert.equal(workspace.workspaceId, 'redemption-space');
    assert.equal(workspace.permissions.canCreatePublicLinks, true); assert.equal(workspace.permissions.canWrite, true);
    assert(workspace.rootPath.startsWith(`${dataRoot}${path.sep}`)); await mkdir(workspace.rootPath, { recursive: true });
    const { createFileGuestService, fileGuestService } = await import('../app/lib/file-guests/service');
    const { isFileGuestInvitationReaderBusy, FileGuestWriterCommitError } = await import('../app/lib/file-guests/writer');
    const delivered = new Map<string, string>();
    const sendCode = async (input: { email: string; code: string }) => {
      assert.match(input.email, /^guest-[a-f0-9-]+@redemption\.invalid$/u); delivered.set(input.email, input.code);
    };
    const guests = createFileGuestService({ sendCode });
    const originalService = { ...fileGuestService };
    Object.assign(fileGuestService, guests);
    const { POST: guestAction } = await import('../app/api/guest/files/[id]/[action]/route');
    const seed = async () => {
      const id = crypto.randomUUID(), documentId = `redemption-${crypto.randomUUID()}`, lineageId = `redemption-lineage-${crypto.randomUUID()}`;
      const filePath = `guest-${crypto.randomUUID()}.md`, email = `guest-${crypto.randomUUID()}@redemption.invalid`;
      const content = 'Native Guest redemption fixture.';
      const doc = new Y.Doc(); let update: Buffer, vector: Buffer;
      try { doc.getText('content').insert(0, content); update = Buffer.from(Y.encodeStateAsUpdate(doc)); vector = Buffer.from(Y.encodeStateVector(doc)); }
      finally { doc.destroy(); }
      await writeFile(path.join(workspace.rootPath, filePath), content);
      await fixture.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
        VALUES($1,'redemption-space','organization','redemption-org',$2,'active',100)`, [lineageId, filePath]);
      await fixture.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
        state_version,yjs_state_lifecycle,status,created_at,updated_at)
        VALUES($1,$2,'redemption-space','organization','redemption-org',$3,'yjs',7,'initialized','active',100,100)`, [documentId, lineageId, filePath]);
      await fixture.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,schema_version,
        yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,checkpointed_at,canonical_hash,serialized_hash,newline_style,has_bom,degraded,status)
        VALUES($1,'redemption-space','redemption-org',$2,'plain_text',1,1,$3,$4,7,100,7,100,NULL,NULL,'lf',0,0,'active')`, [documentId, filePath, update!, vector!]);
      await fixture.query(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,lineage_id,lifecycle_generation,email,permission,status,policy_revision,created_by_user_id,assets_json,created_at,updated_at)
        VALUES($1,'redemption-space',$2,$3,$4,1,$5,'write','active',1,'owner','[]',$6,$6)`, [id, filePath, documentId, lineageId, email, Date.now()]);
      await guests.challenge(id);
      const code = delivered.get(email); assert(code); assert.match(code, /^\d{6}$/u);
      const state = (await fixture.query('SELECT challenge_hash,challenge_attempts,policy_revision FROM file_guest_invitations WHERE id=$1', [id])).rows[0];
      assert.equal(typeof state.challenge_hash, 'string'); assert.equal(Number(state.challenge_attempts), 0);
      return { id, documentId, lineageId, filePath, email, code, challengeHash: state.challenge_hash as string };
    };
    const invitation = async (id: string) => (await fixture.query('SELECT * FROM file_guest_invitations WHERE id=$1', [id])).rows[0] as Row;
    const sessionRows = async (id: string) => (await fixture.query('SELECT * FROM file_guest_sessions WHERE invitation_id=$1 ORDER BY id', [id])).rows as Row[];
    const fingerprintRows = (rows: Row[]) => crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const check = async (name: string, test: () => Promise<void>) => { stage = name; await test(); cases++; console.log(`Guest redemption fixture passed: ${name}`); };
    const action = (id: string, code: string, displayName: string) => guestAction(new NextRequest(`http://localhost/api/guest/files/${id}/verify`, {
      method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ code, displayName }),
    }), { params: Promise.resolve({ id, action: 'verify' }) });
    try {
      await check('actual challenge and native preparation issue one token-bound Guest session', async () => {
        const target = await seed();
        const result = await guests.verify(target.id, target.code, 'Actual guest');
        assert.match(result.token, /^[A-Za-z0-9_-]{43}$/u);
        const sessions = await sessionRows(target.id); assert.equal(sessions.length, 1);
        assert.equal(sessions[0].token_hash, crypto.createHash('sha256').update(result.token).digest('hex'));
        assert.equal((await invitation(target.id)).challenge_hash, null);
        assert.equal((await guests.access(target.id, { token: result.token })).state.documentId, target.documentId);
      });
      await check('actual session INSERT constraint failure rolls consume attempts and expired cleanup back; original code remains usable', async () => {
        const target = await seed(), expiredId = crypto.randomUUID();
        await fixture.query(`INSERT INTO file_guest_sessions(id,invitation_id,token_hash,display_name,expires_at,created_at)
          VALUES($1,$2,$3,'Expired fixture',$4,$5)`, [expiredId, target.id, crypto.randomBytes(32).toString('hex'), Date.now() - 1000, Date.now() - 2000]);
        const before = fingerprintRows(await sessionRows(target.id));
        await fixture.query("ALTER TABLE file_guest_sessions ADD CONSTRAINT guest_redemption_fixture_reject_name CHECK(display_name <> 'Rejected by actual SQL constraint')");
        try {
          await assert.rejects(guests.verify(target.id, target.code, 'Rejected by actual SQL constraint'), error => {
            let current: unknown = error;
            for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
              if (Reflect.get(current, 'code') === '23514'
                && Reflect.get(current, 'constraint') === 'guest_redemption_fixture_reject_name') return true;
              current = Reflect.get(current, 'cause');
            }
            assert.fail('The actual session CHECK constraint must be the reason issuance failed.');
          });
        }
        finally { await fixture.query('ALTER TABLE file_guest_sessions DROP CONSTRAINT guest_redemption_fixture_reject_name'); }
        const after = await invitation(target.id);
        assert.equal(after.challenge_hash === target.challengeHash, true, 'Rejected session issuance must not consume the actual code.');
        assert.equal(Number(after.challenge_attempts), 0, 'Rejected issuance must roll back its attempted redemption.');
        assert.equal(fingerprintRows(await sessionRows(target.id)), before, 'Expired-session cleanup must roll back with issuance.');
        const retried = await guests.verify(target.id, target.code, 'Retry after rolled back SQL');
        assert.equal((await guests.access(target.id, { token: retried.token })).guestSession.displayName, 'Retry after rolled back SQL');
        assert.equal((await sessionRows(target.id)).length, 1);
      });
      await check('wrong code attempts commit independently and the fifth attempt cannot be bypassed', async () => {
        const target = await seed(), wrongCode = target.code === '000000' ? '111111' : '000000';
        for (let count = 1; count <= 5; count++) {
          await assert.rejects(guests.verify(target.id, wrongCode, 'Wrong code'), error => Reflect.get(error as object, 'status') === 401);
          assert.equal(Number((await invitation(target.id)).challenge_attempts), count);
        }
        await assert.rejects(guests.verify(target.id, target.code, 'Attempt after fifth failure'), error => Reflect.get(error as object, 'status') === 401);
        const after = await invitation(target.id); assert.equal(Number(after.challenge_attempts), 5);
        assert.equal(after.challenge_hash === target.challengeHash, true); assert.equal((await sessionRows(target.id)).length, 0);
      });
      await check('two actual writer backends redeem a code only once', async () => {
        const target = await seed(), bothBegun = signal(), release = signal(), backends = new Set<number>();
        let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof guests.verify>>>[]> | undefined;
        await observeQueries(query => {
          if (query.sql === 'BEGIN') return afterRealQuery(query, async () => {
            backends.add(Number(Reflect.get(query.client, 'processID')));
            if (backends.size === 2) bothBegun.resolve();
            await bounded(release.promise, 'The two real redemption transactions were not released.');
          });
          return query.run();
        }, async () => {
          pending = Promise.allSettled([guests.verify(target.id, target.code, 'Concurrent A'), guests.verify(target.id, target.code, 'Concurrent B')]);
          try { await bounded(bothBegun.promise, 'Two distinct actual redemption writer backends never began.'); }
          finally { release.resolve(); }
          const results = await pending;
          assert.equal(backends.size, 2); assert([...backends].every(pid => Number.isSafeInteger(pid) && pid > 0));
          const accepted = results.filter(result => result.status === 'fulfilled');
          assert.equal(accepted.length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
          assert.equal((await sessionRows(target.id)).length, 1); assert.equal((await invitation(target.id)).challenge_hash, null);
        }).finally(async () => { release.resolve(); await pending; });
      });
      await check('actual policy change after invitation read prevents stale consumption', async () => {
        const target = await seed(), read = signal(), release = signal();
        let paused = false, preparationPid = 0, managerPid = 0, managedHash: unknown;
        let pending: PromiseSettledResult<Awaited<ReturnType<typeof guests.verify>>>[] | undefined;
        let verification: Promise<PromiseSettledResult<Awaited<ReturnType<typeof guests.verify>>>[]> | undefined;
        await observeQueries(query => {
          if (!paused && /^SELECT\b/iu.test(query.sql) && /\bFROM\s+(?:"[^"]+"\.)?"?file_guest_invitations"?\b/iu.test(query.sql) && query.values.includes(target.id)) {
            paused = true; preparationPid = Number(Reflect.get(query.client, 'processID'));
            return afterRealQuery(query, async result => {
              assert.equal(Reflect.get(result as object, 'rowCount'), 1); read.resolve();
              await bounded(release.promise, 'The old actual invitation result was not released.');
            });
          }
          if (/^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql) && query.values.includes(target.id)
            && /policy_revision/iu.test(query.sql)) managerPid = Number(Reflect.get(query.client, 'processID'));
          return query.run();
        }, async () => {
          verification = Promise.allSettled([guests.verify(target.id, target.code, 'Stale policy')]);
          try {
            await bounded(read.promise, 'The actual pre-transaction invitation read never completed.');
            const changed = await guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, permission: 'read' });
            assert.equal(changed.policyRevision, 2);
            managedHash = (await invitation(target.id)).challenge_hash;
            assert.equal(managedHash, null, 'The real policy change invalidates its old challenge.');
          } finally { release.resolve(); }
          pending = await verification;
        }).finally(async () => { release.resolve(); await verification; });
        assert(paused); assert(preparationPid > 0); assert(managerPid > 0); assert.notEqual(preparationPid, managerPid);
        assert.equal(pending?.[0].status, 'rejected');
        if (pending?.[0].status === 'rejected') assert.equal(Reflect.get(pending[0].reason as object, 'status'), 409);
        const after = await invitation(target.id); assert.equal(after.challenge_hash, managedHash);
        assert.equal(Number(after.challenge_attempts), 0); assert.equal((await sessionRows(target.id)).length, 0);
      });
      for (const expiry of ['challenge', 'invitation'] as const)
      await check(`actual ${expiry} expiry during a proven row-lock wait cannot extend redemption`, async () => {
        const target = await seed();
        const blocker = new Client({ connectionString, connectionTimeoutMillis: 5000,
          options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-redemption-expiry-blocker` });
        blocker.on('error', () => undefined);
        let holding = false, writerPid = 0, expiryAt = 0, crossedAt = 0;
        let lockAttemptAt = 0, blockingObservedAt = 0, blockerCommitAcknowledgedAt = 0;
        const rowLockEntered = signal();
        let verification: Promise<PromiseSettledResult<Response>[]> | undefined;
        let responses: PromiseSettledResult<Response>[] | undefined;
        try {
          await blocker.connect(); await blocker.query('BEGIN'); holding = true;
          await blocker.query('SELECT id FROM file_guest_invitations WHERE id=$1 FOR UPDATE', [target.id]);
          const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          await observeQueries(query => {
            if (query.client !== blocker && /^SELECT\b/iu.test(query.sql) && /\bfile_guest_invitations\b/iu.test(query.sql)
              && /\bFOR UPDATE\b/iu.test(query.sql) && query.values.includes(target.id)) {
              const actual = Number(Reflect.get(query.client, 'processID'));
              assert(writerPid === 0 || writerPid === actual, 'Repeated row locks must stay on the same actual writer.');
              writerPid = actual;
              if (lockAttemptAt === 0) { lockAttemptAt = Date.now(); rowLockEntered.resolve(); }
            }
            return query.run();
          }, async () => {
            const blockingDeadline = Date.now()+5000;
            verification = Promise.allSettled([action(target.id, target.code, `Waited ${expiry} expiry`)]);
            try {
              const blocked = async () => writerPid > 0 && (await fixture.query(
                'SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [writerPid, blockerPid])).rows[0].blocked === true;
              let entryTimeout: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([rowLockEntered.promise,new Promise<never>((_,reject) => {
                  entryTimeout = setTimeout(() => reject(new Error('The actual Guest writer never entered its invitation row lock query.')),
                    Math.max(0,blockingDeadline-Date.now()));
                })]);
              } finally { if (entryTimeout) clearTimeout(entryTimeout); }
              // Observe actual backend blocking immediately after query entry.
              // Coarse 20ms fixture sleeps must not consume the real 50ms lock budget.
              while (!await blocked()) {
                assert(Date.now()<blockingDeadline,'The actual Guest writer never waited on the owned invitation row lock.');
                await new Promise(resolve => setTimeout(resolve,1));
              }
              blockingObservedAt = Date.now();
              assert.notEqual(writerPid, blockerPid); assert(holding);
              // Respect the existing 50 ms Principal lock timeout unchanged.
              // The actual blocked row and real clock still prove expiry.
              expiryAt = Date.now() + 1;
              if (expiry === 'challenge') await blocker.query('UPDATE file_guest_invitations SET challenge_expires_at=$1 WHERE id=$2', [expiryAt, target.id]);
              else await blocker.query('UPDATE file_guest_invitations SET expires_at=$1 WHERE id=$2', [expiryAt, target.id]);
              const crossingDeadline = Date.now()+5000;
              while (!(Date.now()>expiryAt && await blocked())) {
                assert(Date.now()<crossingDeadline,'The real expiry deadline was not crossed while the genuine writer remained blocked.');
                await new Promise(resolve => setTimeout(resolve,1));
              }
              crossedAt = Date.now(); assert(crossedAt > expiryAt); assert(holding);
              await blocker.query('COMMIT'); holding = false;
              blockerCommitAcknowledgedAt = Date.now();
              responses = await verification;
              console.log('Actual Guest row-lock expiry witness:', JSON.stringify({ expiry, blockerPid, writerPid,
                lockAttemptAt,blockingObservedAt,expiryAt,crossedAt,blockerCommitAcknowledgedAt }));
            } finally {
              if (holding) { await blocker.query('ROLLBACK'); holding = false; }
              await verification;
            }
          });
          assert.equal(responses?.[0].status, 'fulfilled');
          if (responses?.[0].status === 'fulfilled') {
            const response = responses[0].value, expectedStatus = expiry === 'challenge' ? 401 : 410;
            if (response.status !== expectedStatus) {
              const payload: unknown = await response.clone().json().catch(() => undefined);
              const field = (key:string) => payload && typeof payload === 'object' && typeof Reflect.get(payload,key) === 'string'
                ? String(Reflect.get(payload,key)).slice(0,256) : null;
              console.error('Actual Guest row-lock expiry unexpected HTTP response:',JSON.stringify({expiry,status:response.status,
                expectedStatus,code:field('code'),error:field('error')}));
            }
            assert.equal(response.status, expectedStatus);
            assert.equal(responses[0].value.headers.get('set-cookie'), null);
          }
          const after = await invitation(target.id);
          assert.equal(after.challenge_hash === target.challengeHash, true);
          assert.equal(Number(after.challenge_attempts), 0); assert.equal((await sessionRows(target.id)).length, 0);
          assert.equal(Number(after[expiry === 'challenge' ? 'challenge_expires_at' : 'expires_at']), expiryAt);
        } finally {
          if (holding) await blocker.query('ROLLBACK').catch(() => undefined);
          await blocker.end().catch(() => undefined); await verification;
        }
      });
      await check('wrong-code actual COMMIT ACK loss reports unconfirmed503 rather than a falsely confirmed401', async () => {
        const target = await seed(), wrongCode = target.code === '000000' ? '111111' : '000000';
        const checkoutReleases = new Map<Client, (error?: Error) => void>();
        let writerPid = 0, attempts = 0, consumes = 0, inserts = 0, commits = 0, rollbacks = 0, releases = 0;
        let committed = false, released = false, discarded = false;
        const lostAck = Object.assign(new Error('Owned fixture lost a successfully committed invalid-code counter ACK.'), { code: 'ECONNRESET' });
        try {
          await observeQueries(query => {
            if (/^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql)
              && /challenge_attempts\s*=\s*challenge_attempts\s*\+\s*1/iu.test(query.sql) && query.values.includes(target.id)) {
              attempts++; writerPid = Number(Reflect.get(query.client, 'processID'));
              if (!checkoutReleases.has(query.client)) {
                const release = Reflect.get(query.client, 'release') as (error?: Error) => void;
                assert.equal(typeof release, 'function'); checkoutReleases.set(query.client, release);
                Reflect.set(query.client, 'release', (error?: Error) => {
                  releases++; discarded = error instanceof Error;
                  const result = Reflect.apply(release, query.client, [error]); released = true; return result;
                });
              }
            }
            if (checkoutReleases.has(query.client)) {
              if (/^UPDATE\b/iu.test(query.sql) && /challenge_hash\s*=\s*NULL/iu.test(query.sql)) consumes++;
              if (/^INSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_guest_sessions"?/iu.test(query.sql)) inserts++;
              if (query.sql === 'ROLLBACK') rollbacks++;
              if (query.sql === 'COMMIT') { commits++; return afterRealQuery(query, () => { committed = true; throw lostAck; }); }
            }
            return query.run();
          }, async () => {
            const response = await action(target.id, wrongCode, 'Invalid-code unknown COMMIT');
            assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
            const payload = await response.json(); assert.equal(payload.code, 'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED');
            assert.equal(payload.success, false); assert(committed); assert(released); assert(discarded);
          });
          assert.equal(checkoutReleases.size, 1); assert(writerPid > 0); assert.equal(attempts, 1);
          assert.equal(consumes, 0); assert.equal(inserts, 0); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(releases, 1);
          await waitFor(async () => (await fixture.query(
            'SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [writerPid])).rows[0].absent === true,
          'The discarded invalid-code Guest writer backend remained present.');
          const after = await invitation(target.id); assert.equal(Number(after.challenge_attempts), 1);
          assert.equal(after.challenge_hash === target.challengeHash, true); assert.equal((await sessionRows(target.id)).length, 0);
        } finally { for (const [client, release] of checkoutReleases) Reflect.set(client, 'release', release); }
      });
      for (const mode of ['lost-ack', 'lost-ack-discard-throws', 'confirmed-commit-release-throws'] as const)
      await check(`actual successful COMMIT transport ambiguity ${mode} reports 503 without cookie or replay`, async () => {
        const target = await seed();
        const checkoutReleases = new Map<Client, (error?: Error) => void>();
        let pid = 0, consumes = 0, inserts = 0, commits = 0, rollbacks = 0, releaseCalls = 0;
        let committed = false, released = false, releaseHadError = false, releaseThrew = false;
        const lostAck = Object.assign(new Error('Owned fixture lost the successful Guest COMMIT acknowledgement.'), { code: 'ECONNRESET' });
        const closeError = new Error('Owned fixture threw after the genuine Guest checkout release.');
        try {
          await observeQueries(query => {
            if (/^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql)
              && /challenge_hash\s*=\s*NULL/iu.test(query.sql) && query.values.includes(target.id)) {
              consumes++; pid = Number(Reflect.get(query.client, 'processID'));
              if (!checkoutReleases.has(query.client)) {
                const release = Reflect.get(query.client, 'release') as (error?: Error) => void;
                assert.equal(typeof release, 'function'); checkoutReleases.set(query.client, release);
                Reflect.set(query.client, 'release', (error?: Error) => {
                  releaseCalls++; releaseHadError = error instanceof Error;
                  const result = Reflect.apply(release, query.client, [error]); released = true;
                  if (mode !== 'lost-ack') { releaseThrew = true; throw closeError; }
                  return result;
                });
              }
            }
            if (checkoutReleases.has(query.client)) {
              if (/^INSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_guest_sessions"?/iu.test(query.sql)) inserts++;
              if (query.sql === 'ROLLBACK') rollbacks++;
              if (query.sql === 'COMMIT') { commits++; return afterRealQuery(query, () => {
                committed = true; if (mode !== 'confirmed-commit-release-throws') throw lostAck;
              }); }
            }
            return query.run();
          }, async () => {
            const response = await action(target.id, target.code, `Actual COMMIT ${mode}`);
            assert.equal(response.status, 503); assert.equal(response.headers.get('set-cookie'), null);
            const payload = await response.json(); assert.equal(payload.code, 'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED');
            assert.equal(payload.success, false);
            assert.equal(committed, true); assert.equal(released, true);
            assert.equal(releaseHadError, mode !== 'confirmed-commit-release-throws'); assert.equal(releaseThrew, mode !== 'lost-ack');
          });
          assert.equal(checkoutReleases.size, 1); assert(pid > 0); assert.equal(consumes, 1); assert.equal(inserts, 1);
          assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(releaseCalls, 1);
          if (mode !== 'confirmed-commit-release-throws') await waitFor(async () =>
            (await fixture.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [pid])).rows[0].absent === true,
          'The actually discarded Guest writer backend remained present.');
          assert.equal((await invitation(target.id)).challenge_hash, null); assert.equal((await sessionRows(target.id)).length, 1);
        } finally { for (const [client, release] of checkoutReleases) Reflect.set(client, 'release', release); }
      });
      assert.equal(cases, 11, 'The original eleven actual-service redemption families remain covered.');
      const { GET: fileInfo } = await import('../app/api/files/info/route');
      const { createCollaborationAdmissionService } = await import('../app/lib/collaboration/room-admission');
      const { collaborationAdmissionActionDigest } = await import('../app/lib/collaboration/room-admission-contract');
      const { createCollaborationRoomOwnerSession } = await import('../app/lib/collaboration/room-owner');
      const admission = createCollaborationAdmissionService({ openConnection: database.openDb });
      const expectedTarget = async (target: Awaited<ReturnType<typeof seed>>) => {
        const response = await fileInfo(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({ path: target.filePath })}`,
          { headers: memberRequest().headers }));
        assert.equal(response.status, 200);
        const selected = (await response.json()).data.metadataTarget as WorkspaceFileMetadataTarget;
        assert.deepEqual(selected, { version: 1, kind: 'native_file', workspaceId: workspace.workspaceId,
          path: target.filePath, documentId: target.documentId, lifecycleGeneration: 1 });
        return selected;
      };
      const createInput = async (target: Awaited<ReturnType<typeof seed>>, permission: 'read' | 'write' = 'read') => ({
        workspaceId: workspace.workspaceId, path: target.filePath, expectedTarget: await expectedTarget(target),
        email: `guest-${crypto.randomUUID()}@redemption.invalid`, permission, expiresAt: null,
      });
      const nativeProof = async (target: Awaited<ReturnType<typeof seed>>) => fingerprintRows((await fixture.query(`SELECT jsonb_build_object(
        'document',(SELECT to_jsonb(d) FROM collaboration_documents d WHERE d.id=$1),
        'lineage',(SELECT to_jsonb(l) FROM file_collaboration_lineages l WHERE l.id=$2),
        'state',(SELECT to_jsonb(s) FROM collaboration_yjs_states s WHERE s.document_id=$1)) AS snapshot`,
      [target.documentId, target.lineageId])).rows);
      const busy = (error: unknown) => !!error && typeof error === 'object' && Reflect.get(error, 'code') === 'SIDE_EFFECT_WRITER_BUSY';
      const denied = (error: unknown) => !!error && typeof error === 'object'
        && (['PRINCIPAL_AUTH_REVOKED','PRINCIPAL_ACCESS_DENIED','FILE_GUEST_WRITE_DENIED','FILE_GUEST_INVITATION_SCOPE_CHANGED',
          'FILE_GUEST_INVITATION_UNAVAILABLE','FILE_GUEST_TARGET_CHANGED','FILE_GUEST_BINDING_UNAVAILABLE'].includes(String(Reflect.get(error,'code')))
          || [400,401,403,404,409,410].includes(Number(Reflect.get(error,'status'))));
      await check('actual Create preserves native-only content and an active room owner without reading the Markdown projection', async () => {
        const target = await seed(), input = await createInput(target);
        await rm(path.join(workspace.rootPath, target.filePath));
        const ownerClient = new Client({ connectionString, connectionTimeoutMillis: 5000,
          options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000` });
        ownerClient.on('error', () => undefined); await ownerClient.connect();
        const owner = await createCollaborationRoomOwnerSession(ownerClient);
        try {
          const held = await owner.acquire({ documentId: target.documentId, workspaceId: workspace.workspaceId,
            organizationId: workspace.organizationId ?? null, path: target.filePath, representation: 'plain_text', lifecycleGeneration: 1, schemaVersion: 1 });
          const beforeOwned = await nativeProof(target);
          const historyBackends = new Set<number>(), invitationBackends = new Set<number>();
          let historyInserts = 0;
          const created = await observeQueries(query => {
            if (/^INSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_guest_versions"?/iu.test(query.sql) && query.values.includes(target.documentId)) {
              historyInserts++; historyBackends.add(Number(Reflect.get(query.client, 'processID')));
            }
            if (/^INSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql) && query.values.includes(input.email)) {
              invitationBackends.add(Number(Reflect.get(query.client, 'processID')));
            }
            return query.run();
          }, () => guests.create(memberRequest(), input));
          assert.equal(historyInserts, 1); assert.equal(historyBackends.size, 1);
          assert.deepEqual([...historyBackends], [...invitationBackends]);
          assert.equal(created.status, 'active'); assert.equal(created.permission, 'read'); assert.equal(created.createdByUserId, 'owner');
          const actual = await invitation(created.id);
          assert.equal(actual.document_id, target.documentId); assert.equal(actual.lineage_id, target.lineageId);
          assert.equal(Number(actual.lifecycle_generation), 1); assert.equal(actual.path, target.filePath);
          const history = (await fixture.query('SELECT * FROM file_guest_versions WHERE workspace_id=$1 AND document_id=$2',
            [workspace.workspaceId, target.documentId])).rows;
          assert.equal(history.length, 1); assert.equal(Number(history[0].lifecycle_generation), 1); assert.equal(Number(history[0].document_sequence), 7);
          assert.equal(history[0].content, 'Native Guest redemption fixture.');
          assert.equal(history[0].content_hash, crypto.createHash('sha256').update('Native Guest redemption fixture.').digest('hex'));
          await owner.assertActive(held);
          await assert.rejects(stat(path.join(workspace.rootPath, target.filePath)), { code: 'ENOENT' });
          await guests.challenge(created.id); const code = delivered.get(input.email); assert(code);
          const session = await guests.verify(created.id, code, 'Native-only Guest');
          const access = await guests.access(created.id, { token: session.token });
          assert.equal(access.state.documentId, target.documentId); assert.equal(access.state.lifecycleGeneration, 1);
          await owner.assertActive(held); assert.equal(await nativeProof(target), beforeOwned);
        } finally { await owner.close(); }
      });
      await check('actual Manage changes policy under member authority and rejects an already used policy revision', async () => {
        const target = await seed(), created = await guests.create(memberRequest(), await createInput(target));
        const before = await nativeProof(target), expiresAt = new Date(Date.now() + 3_600_000);
        const updated = await guests.manage(memberRequest(), workspace.workspaceId, created.id,
          { policyRevision: 1, permission: 'write', expiresAt });
        assert.equal(updated.permission, 'write'); assert.equal(updated.policyRevision, 2); assert.equal(updated.expiresAt, expiresAt.toISOString());
        const committed = fingerprintRows([await invitation(created.id)]);
        await assert.rejects(guests.manage(memberRequest(), workspace.workspaceId, created.id, { policyRevision: 1, permission: 'read' }));
        assert.equal(fingerprintRows([await invitation(created.id)]), committed); assert.equal(await nativeProof(target), before);
      });
      await check('actual Create denies unauthenticated fabricated contexts and stale or mismatched Info targets without invitations', async () => {
        const target = await seed(), other = await seed(), input = await createInput(target);
        const before = Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations')).rows[0].n);
        await assert.rejects(guests.create(new NextRequest('http://localhost/api/files/guests'), input), denied);
        await assert.rejects(guests.create({ ...workspace } as unknown as NextRequest, input));
        await assert.rejects(guests.create(memberRequest(), { ...input,
          expectedTarget: { ...input.expectedTarget, kind: 'native_file', documentId: other.documentId, lifecycleGeneration: 1 } }));
        await fixture.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [target.documentId]);
        await assert.rejects(guests.create(memberRequest(), input), denied);
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations')).rows[0].n), before);
      });
      await fixture.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
        VALUES('member','Member','member@redemption.test',1,'user',0,$1,$1)`, [Date.now()]);
      await fixture.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,can_create_public_links,created_at,updated_at)
        VALUES('redemption-org','member','member','active',0,1,100,100)`);
      await fixture.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
        VALUES('member-seat','redemption-org','member@redemption.test','member','member','active',100,200,100,100)`);
      const readMemberToken = crypto.randomBytes(32).toString('hex');
      await fixture.query(`INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at)
        VALUES('guest-fixture-read-member-session',$1,'member',$2,$3,$3)`, [readMemberToken, Date.now() + 7 * 86400000, Date.now()]);
      const readMemberRequest = () => new NextRequest('http://localhost/api/files/guests', {
        headers: { authorization: `Bearer ${readMemberToken}`, 'x-canvas-workspace-id': workspace.workspaceId },
      });
      await check('actual member Create requires current sharing and write rights while read invitations need no write right', async () => {
        const target = await seed(), input = await createInput(target);
        const created = await guests.create(readMemberRequest(), input);
        assert.equal(created.createdByUserId, 'member'); assert.equal(created.permission, 'read');
        const before = Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations')).rows[0].n);
        await assert.rejects(guests.create(readMemberRequest(), { ...input, email: `guest-${crypto.randomUUID()}@redemption.invalid`, permission: 'write' }), denied);
        await assert.rejects(guests.manage(readMemberRequest(), workspace.workspaceId, created.id, { policyRevision: 1, permission: 'write' }), denied);
        try {
          await fixture.query("UPDATE organization_user_permissions SET can_create_public_links=0 WHERE user_id='member'");
          await assert.rejects(guests.create(readMemberRequest(), { ...input, email: `guest-${crypto.randomUUID()}@redemption.invalid` }), denied);
        } finally { await fixture.query("UPDATE organization_user_permissions SET can_create_public_links=1 WHERE user_id='member'"); }
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations')).rows[0].n), before);
        assert.equal((await guests.manage(readMemberRequest(), workspace.workspaceId, created.id, { policyRevision: 1, revoke: true })).status, 'revoked');
      });
      await check('all actual Guest mutations and access honor the existing real Shared admission reservation', async () => {
        const target = await seed(), input = await createInput(target), issued = await guests.verify(target.id, target.code, 'Before reservation');
        const before = fingerprintRows([await invitation(target.id)]), sessionBefore = fingerprintRows(await sessionRows(target.id));
        const deliveries = delivered.size, actionPayloadText = JSON.stringify({ source: target.filePath, destination: `reserved-${crypto.randomUUID()}.md` });
        const reserved = { requestId: crypto.randomUUID(), actorId: 'owner', action: 'move' as const, actionPayloadText,
          actionDigest: collaborationAdmissionActionDigest('move', actionPayloadText),
          scopes: [{ workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, path: target.filePath, kind: 'exact' as const }],
          expectedDocuments: [{ documentId: target.documentId, workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null,
            path: target.filePath, representation: 'plain_text' as const, lifecycleGeneration: 1, schemaVersion: 1, status: 'active' as const }] };
        await admission.reserve(reserved);
        try {
          await assert.rejects(guests.create(memberRequest(), input), busy);
          await assert.rejects(guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, permission: 'read' }), busy);
          await assert.rejects(guests.challenge(target.id), busy);
          await assert.rejects(guests.verify(target.id, target.code, 'Reserved verify'), busy);
          await assert.rejects(guests.access(target.id, { token: issued.token }), busy);
          await assert.rejects(guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, revoke: true }), busy);
          assert.equal(fingerprintRows([await invitation(target.id)]), before); assert.equal(fingerprintRows(await sessionRows(target.id)), sessionBefore);
          assert.equal(delivered.size, deliveries);
        } finally { await admission.cancel(reserved, 1); }
        assert.equal((await guests.access(target.id, { token: issued.token })).state.documentId, target.documentId);
      });
      await check('actual regular Guest paths reject nullable stale missing and malformed bindings while member revoke remains monotone', async () => {
        for (const kind of ['nullable','stale','missing','malformed'] as const) {
          const target = await seed(), issued = await guests.verify(target.id, target.code, 'Before binding change');
          if (kind === 'nullable') await fixture.query('UPDATE file_guest_invitations SET lineage_id=NULL,lifecycle_generation=NULL WHERE id=$1', [target.id]);
          if (kind === 'stale') await fixture.query('UPDATE collaboration_yjs_states SET lifecycle_generation=2 WHERE document_id=$1', [target.documentId]);
          if (kind === 'missing') await fixture.query('DELETE FROM collaboration_yjs_states WHERE document_id=$1', [target.documentId]);
          if (kind === 'malformed') await fixture.query("UPDATE file_guest_invitations SET path='../malformed-guest.md' WHERE id=$1", [target.id]);
          const before = await invitation(target.id), deliveries = delivered.size;
          await assert.rejects(guests.challenge(target.id), denied);
          await assert.rejects(guests.verify(target.id, target.code, 'Cannot rebind'), denied);
          await assert.rejects(guests.access(target.id, { token: issued.token }), denied);
          await assert.rejects(guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, permission: 'read' }), denied);
          assert.equal(fingerprintRows([await invitation(target.id)]), fingerprintRows([before])); assert.equal(delivered.size, deliveries);
          const revoked = await guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, revoke: true });
          assert.equal(revoked.status, 'revoked'); assert.equal(revoked.policyRevision, 2);
          const after = await invitation(target.id);
          for (const key of ['workspace_id','path','document_id','lineage_id','lifecycle_generation','created_by_user_id','permission']) assert.equal(after[key], before[key]);
        }
      });
      await check('actual failed delivery clears only the committed challenge through a fresh writer and issues no session', async () => {
        const target = await seed();
        await fixture.query('UPDATE file_guest_invitations SET challenge_sent_at=NULL WHERE id=$1', [target.id]);
        let sawCommitted = false;
        const failing = createFileGuestService({ sendCode: async () => {
          const row = await invitation(target.id); assert.equal(typeof row.challenge_hash, 'string');
          assert.equal(Number(row.challenge_send_count), 2); sawCommitted = true; throw new Error('Owned fixture delivery failure');
        } });
        await assert.rejects(failing.challenge(target.id), error => Number(Reflect.get(error as object, 'status')) === 503);
        assert(sawCommitted); const after = await invitation(target.id);
        assert.equal(after.challenge_hash, null); assert.equal(Number(after.challenge_send_count), 2);
        assert.equal((await sessionRows(target.id)).length, 0);
      });
      for (const race of ['later-challenge','policy-and-later-challenge'] as const)
      await check(`actual failed delivery cannot erase ${race} on the same invitation`, async () => {
        const target = await seed();
        await fixture.query('UPDATE file_guest_invitations SET challenge_sent_at=NULL WHERE id=$1', [target.id]);
        let replacement: Row | undefined;
        const failing = createFileGuestService({ sendCode: async () => {
          if (race === 'policy-and-later-challenge') await guests.manage(memberRequest(), workspace.workspaceId, target.id,
            { policyRevision: 1, permission: 'read' });
          // Owned fixture precondition permits another request without a fake
          // clock or waiting a minute. Challenge SQL/counters stay original.
          await fixture.query('UPDATE file_guest_invitations SET challenge_sent_at=NULL WHERE id=$1', [target.id]);
          await guests.challenge(target.id);
          replacement = await invitation(target.id);
          assert.equal(Number(replacement.challenge_send_count), 3); assert.equal(typeof replacement.challenge_hash, 'string');
          throw new Error('The earlier owned delivery failed after a newer actual challenge committed.');
        } });
        await assert.rejects(failing.challenge(target.id), error => Number(Reflect.get(error as object, 'status')) === 503);
        assert(replacement);
        assert.equal(fingerprintRows([await invitation(target.id)]), fingerprintRows([replacement]));
        const code = delivered.get(target.email); assert(code);
        const verified = await guests.verify(target.id, code, 'The later challenge remains usable');
        assert.equal((await guests.access(target.id, { token: verified.token })).state.documentId, target.documentId);
      });
      await check('actual Create Verify and access reject real TEMP shadows of all three Guest relations on their own B', async () => {
        for (const family of ['create','verify','access'] as const)
        for (const relation of ['file_guest_invitations','file_guest_sessions','file_guest_versions'] as const) {
          const target = await seed(), input = await createInput(target);
          const issued = family === 'access' ? await guests.verify(target.id, target.code, 'Before actual TEMP shadow') : undefined;
          const before = fingerprintRows([await invitation(target.id)]), sessionBefore = fingerprintRows(await sessionRows(target.id));
          let injected = false, writerPid = 0, rolledBack = false, shadowGone = false;
          await observeQueries(query => {
            if (!injected && query.sql.startsWith('SELECT name,to_regclass(name)') && query.sql.includes('resolved_oid')) {
              injected = true; writerPid = Number(Reflect.get(query.client, 'processID'));
              return Promise.resolve(Reflect.apply(originalClientQuery, query.client,
                [`CREATE TEMP TABLE "${relation}" (LIKE "${schema}"."${relation}" INCLUDING ALL) ON COMMIT DROP`])).then(async () => {
                const actual = await Reflect.apply(originalClientQuery, query.client,
                  ['SELECT to_regclass($1)::oid<>to_regclass($2)::oid AS shadowed', [relation, `"${schema}"."${relation}"`]]);
                assert.equal(actual.rows[0].shadowed, true); return query.run();
              });
            }
            if (injected && Number(Reflect.get(query.client, 'processID')) === writerPid && query.sql === 'ROLLBACK') {
              return afterRealQuery(query, async () => {
                rolledBack = true;
                const actual = await Reflect.apply(originalClientQuery, query.client,
                  ['SELECT to_regclass($1) IS NULL AS absent', [`pg_temp.${relation}`]]);
                shadowGone = actual.rows[0].absent === true;
              });
            }
            return query.run();
          }, async () => {
            const operation = family === 'create' ? guests.create(memberRequest(), input)
              : family === 'verify' ? guests.verify(target.id, target.code, 'Rejected actual TEMP shadow')
              : guests.access(target.id, { token: issued!.token });
            await assert.rejects(operation, error => ['FILE_GUEST_WRITE_CHANGED','PRINCIPAL_SCHEMA_INVALID'].includes(String(Reflect.get(error as object, 'code'))));
          });
          assert(injected); assert(writerPid > 0); assert(rolledBack); assert(shadowGone);
          assert.equal(fingerprintRows([await invitation(target.id)]), before); assert.equal(fingerprintRows(await sessionRows(target.id)), sessionBefore);
          assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations WHERE email=$1', [input.email])).rows[0].n), 0);
        }
      });
      for (const family of ['create','manage','access'] as const)
      for (const mode of ['lost-ack','lost-ack-discard-throws','confirmed-commit-release-throws'] as const)
      await check(`actual service ${family} COMMIT ambiguity ${mode} publishes no success or automatic replay`, async () => {
        const target = await seed(), input = await createInput(target);
        const issued = family === 'access' ? await guests.verify(target.id, target.code, 'Before read COMMIT ambiguity') : undefined;
        const nativeBefore = await nativeProof(target), before = fingerprintRows([await invitation(target.id)]), sessionsBefore = fingerprintRows(await sessionRows(target.id));
        const checkoutReleases = new Map<Client, (error?: Error) => void>();
        let pid = 0, narrowStatements = 0, commits = 0, rollbacks = 0, disposals = 0, dmlAfterRead = 0;
        let committed = false, disposed = false, discarded = false, disposalThrew = false, published = false;
        const lostAck = Object.assign(new Error('Owned service fixture lost ACK after a successful real COMMIT.'), { code: 'ECONNRESET' });
        const releaseError = new Error('Owned service fixture failed only after the actual checkout disposal.');
        try {
          await observeQueries(query => {
            const trigger = family === 'create' ? /^INSERT\s+INTO\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql) && query.values.includes(input.email)
              : family === 'manage' ? /^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql) && query.values.includes(target.id) && /SET\s+permission\s*=/iu.test(query.sql)
              : /^SELECT\b/iu.test(query.sql) && /\bFROM\s+(?:"[^"]+"\.)?"?file_guest_sessions"?\b/iu.test(query.sql) && query.values.includes(target.id);
            if (trigger) {
              narrowStatements++; pid = Number(Reflect.get(query.client, 'processID'));
              if (!checkoutReleases.has(query.client)) {
                const release = Reflect.get(query.client, 'release') as (error?: Error) => void;
                assert.equal(typeof release, 'function'); checkoutReleases.set(query.client, release);
                Reflect.set(query.client, 'release', (error?: Error) => {
                  disposals++; discarded = error instanceof Error;
                  const result = Reflect.apply(release, query.client, [error]); disposed = true;
                  if (mode !== 'lost-ack') { disposalThrew = true; throw releaseError; } return result;
                });
              }
            }
            if (checkoutReleases.has(query.client)) {
              if (family === 'access' && /^(?:INSERT|UPDATE|DELETE)\b/iu.test(query.sql)) dmlAfterRead++;
              if (query.sql === 'ROLLBACK') rollbacks++;
              if (query.sql === 'COMMIT') { commits++; return afterRealQuery(query, () => {
                committed = true; if (mode !== 'confirmed-commit-release-throws') throw lostAck;
              }); }
            }
            return query.run();
          }, async () => {
            const operation = family === 'create' ? guests.create(memberRequest(), input)
              : family === 'manage' ? guests.manage(memberRequest(), workspace.workspaceId, target.id, { policyRevision: 1, permission: 'read' })
              : guests.access(target.id, { token: issued!.token });
            await assert.rejects(operation.then(value => { published = true; return value; }), error => {
              assert.equal(Reflect.get(error as object, 'code'), 'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED'); assert.equal(Number(Reflect.get(error as object, 'status')), 503);
              assert.equal(isFileGuestInvitationReaderBusy(error),false,'An actual unconfirmed COMMIT is never a transient Reader rejection.');
              assert(committed); assert(disposed); assert.equal(discarded, mode !== 'confirmed-commit-release-throws');
              assert.equal(disposalThrew, mode !== 'lost-ack'); return true;
            });
          });
          assert.equal(published, false); assert.equal(checkoutReleases.size, 1); assert(pid > 0);
          assert.equal(narrowStatements, 1); assert.equal(commits, 1); assert.equal(rollbacks, 0); assert.equal(disposals, 1); assert.equal(dmlAfterRead, 0);
          if (mode !== 'confirmed-commit-release-throws') await waitFor(async () =>
            (await fixture.query('SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent', [pid])).rows[0].absent === true,
          'The actually discarded service backend remained present.');
          if (family === 'create') {
            const actual = (await fixture.query('SELECT * FROM file_guest_invitations WHERE email=$1', [input.email])).rows;
            assert.equal(actual.length, 1); assert.equal(actual[0].document_id, target.documentId); assert.equal(Number(actual[0].policy_revision), 1);
            assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_versions WHERE document_id=$1', [target.documentId])).rows[0].n), 1);
          } else if (family === 'manage') {
            const actual = await invitation(target.id); assert.equal(actual.permission, 'read'); assert.equal(Number(actual.policy_revision), 2);
            assert.equal(actual.challenge_hash, null);
          } else assert.equal(fingerprintRows([await invitation(target.id)]), before);
          assert.equal(fingerprintRows(await sessionRows(target.id)), sessionsBefore); assert.equal(await nativeProof(target), nativeBefore);
        } finally { for (const [client, release] of checkoutReleases) Reflect.set(client, 'release', release); }
      });
      await check('actual Challenge COMMIT ACK loss sends no email and never automatically repeats its mutation', async () => {
        const target = await seed();
        await fixture.query('UPDATE file_guest_invitations SET challenge_sent_at=NULL WHERE id=$1', [target.id]);
        const deliveriesBefore = delivered.get(target.email);
        let commits = 0, updates = 0, writer: Client | undefined;
        await observeQueries(query => {
          if (/^UPDATE\s+(?:"[^"]+"\.)?"?file_guest_invitations"?/iu.test(query.sql) && /SET\s+challenge_id\s*=/iu.test(query.sql) && query.values.includes(target.id)) {
            updates++; writer = query.client;
          }
          if (query.client === writer && query.sql === 'COMMIT') { commits++; return afterRealQuery(query, () => { throw Object.assign(new Error('Owned actual challenge ACK loss.'), { code: 'ECONNRESET' }); }); }
          return query.run();
        }, () => assert.rejects(guests.challenge(target.id), error => Reflect.get(error as object, 'code') === 'FILE_GUEST_WRITE_COMMIT_UNCONFIRMED'));
        assert.equal(updates, 1); assert.equal(commits, 1); assert.equal(delivered.get(target.email), deliveriesBefore);
        const after = await invitation(target.id); assert.equal(Number(after.challenge_send_count), 2); assert.equal(typeof after.challenge_hash, 'string');
        assert.equal((await sessionRows(target.id)).length, 0);
      });
      await check('actual Create and Guest content preserve XML and Blocks content with no Markdown projection or stable export', async () => {
        const { nativeTableWidthFixture } = await import('./helpers/rich-markdown-projection-fixtures');
        const { validateRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
        const { loadCollaborationState } = await import('../app/lib/collaboration/persistence');
        const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
        for (const representation of ['tiptap_xml','tiptap_blocks'] as const) {
          const target = await seed(), doc = nativeTableWidthFixture(representation, 'Native Guest table 😀');
          try {
            assert.equal(validateRichMarkdownYDoc(doc).code, 'roundtrip_unstable');
            await fixture.query('UPDATE collaboration_yjs_states SET representation=$1,yjs_state=$2,state_vector=$3 WHERE document_id=$4',
              [representation, Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), target.documentId]);
          } finally { doc.destroy(); }
          await rm(path.join(workspace.rootPath, target.filePath));
          const persisted = await loadCollaborationState(target.documentId); assert(persisted);
          const expected = authoritativeNativeCollaborationSnapshot(persisted).content, before = await nativeProof(target);
          const input = await createInput(target), created = await guests.create(memberRequest(), input);
          await guests.challenge(created.id); const code = delivered.get(input.email); assert(code);
          const verified = await guests.verify(created.id, code, 'Native rich Guest');
          const content = await guests.content(created.id, verified.token);
          assert.equal(content.bootstrap.kind, 'native_document'); assert.deepEqual(content.bootstrap.content, expected);
          assert.equal(Object.hasOwn(content, 'markdown'), false); assert.equal(await nativeProof(target), before);
          assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_versions WHERE document_id=$1', [target.documentId])).rows[0].n), 0);
          await assert.rejects(stat(path.join(workspace.rootPath, target.filePath)), { code: 'ENOENT' });
        }
      });
      await check('actual Guest claim checks preserve exact outer spaces and reject every mismatched native ticket field on one reader B', async () => {
        const target = await seed(), neighbor = await seed();
        const exactPath = ` renamed-${crypto.randomUUID()}.bin `, trimmedPath = exactPath.trim();
        // Owned fixture arrangement only, not a claim of a runtime Move.
        for (const [document, destination] of [[target, exactPath], [neighbor, trimmedPath]] as const) {
          await fixture.query('UPDATE collaboration_yjs_states SET path=$1 WHERE document_id=$2', [destination, document.documentId]);
          await fixture.query('UPDATE collaboration_documents SET path=$1 WHERE id=$2', [destination, document.documentId]);
          await fixture.query('UPDATE file_collaboration_lineages SET path=$1 WHERE id=$2', [destination, document.lineageId]);
          await fixture.query('UPDATE file_guest_invitations SET path=$1 WHERE id=$2', [destination, document.id]);
        }
        await rm(path.join(workspace.rootPath, target.filePath));
        await writeFile(path.join(workspace.rootPath, trimmedPath), 'The trimmed native neighbor is not the Guest target.');
        const verified = await guests.verify(target.id, target.code, 'Exact native Guest');
        const { fileGuestCollaborationSession } = await import('../app/lib/file-guests/collaboration');
        const { verifyCollaborationTicket, issueCollaborationTicket } = await import('../app/lib/collaboration/ticket');
        const { resolveCollaborationSessionAccess, assertCollaborationDocumentAccess, revalidateCollaborationAccess }
          = await import('../app/lib/collaboration/connection-access');
        const session = await fileGuestCollaborationSession(target.id, verified.token), claims = verifyCollaborationTicket(session.token);
        assert.equal(claims.path, exactPath); assert.equal(claims.documentId, target.documentId);
        const ownerIssued = issueCollaborationTicket({ userId: 'owner', sessionId: 'guest-fixture-owner-session',
          workspaceId: workspace.workspaceId, organizationId: workspace.organizationId ?? null, documentId: target.documentId,
          path: exactPath, provider: 'yjs', representation: 'plain_text', permission: 'write', lifecycleGeneration: 1 });
        const ownerClaims = verifyCollaborationTicket(ownerIssued.token), ownerAccess = await resolveCollaborationSessionAccess(ownerClaims);
        assert.equal(ownerAccess.user.id, 'owner'); assert.equal(ownerAccess.workspace.permissions.canWrite, true);
        assert.equal((await assertCollaborationDocumentAccess(ownerClaims, ownerAccess.workspace)).documentId, target.documentId);
        assert.equal((await revalidateCollaborationAccess(ownerClaims)).state.path, exactPath);
        for (const change of [{path:trimmedPath},{documentId:neighbor.documentId},{workspaceId:'wrong-workspace'},
          {organizationId:'wrong-organization'},{lifecycleGeneration:2},{representation:'tiptap_xml' as const},{schemaVersion:2}]) {
          await assert.rejects(assertCollaborationDocumentAccess({...ownerClaims,...change},ownerAccess.workspace),
            error => Reflect.get(error as object,'code') === 'COLLABORATION_ACCESS_REVOKED');
        }
        assert.equal((await resolveCollaborationSessionAccess(claims)).user.id, `guest:${target.id}`);
        assert.equal((await assertCollaborationDocumentAccess(claims, workspace)).documentId, target.documentId);
        let begins = 0, commits = 0, persistedRows = 0, sessionReads = 0;
        await observeQueries(query => {
          if (query.sql === 'BEGIN') begins++; if (query.sql === 'COMMIT') commits++;
          if (/^SELECT \* FROM collaboration_yjs_states\b/u.test(query.sql)) persistedRows++;
          if (/\bFROM\s+file_guest_sessions\b/u.test(query.sql)) sessionReads++;
          return query.run();
        }, async () => {
          const checked = await revalidateCollaborationAccess(claims);
          assert.equal(checked.state.path, exactPath); assert.equal(checked.state.documentId, target.documentId);
        });
        assert.equal(begins, 1); assert.equal(commits, 1); assert.equal(persistedRows, 1); assert.equal(sessionReads, 1);
        const changes: Partial<CollaborationTicketClaims>[] = [
          { guestInvitationId: neighbor.id }, { guestPolicyRevision: 2 }, { userId: `guest:${neighbor.id}` },
          { sessionId: crypto.randomUUID() }, { workspaceId: 'other-workspace' }, { organizationId: 'other-organization' },
          { documentId: neighbor.documentId }, { path: trimmedPath }, { representation: 'tiptap_xml' },
          { lifecycleGeneration: 2 }, { schemaVersion: 2 }, { permission: 'read' },
          { provider: 'invalid-provider' as CollaborationTicketClaims['provider'] },
        ];
        const before = await nativeProof(target), beforeNeighbor = await nativeProof(neighbor);
        for (const change of changes) await assert.rejects(revalidateCollaborationAccess({ ...claims, ...change }), error =>
          Reflect.get(error as object, 'code') === 'COLLABORATION_ACCESS_REVOKED' || denied(error));
        assert.equal(await nativeProof(target), before); assert.equal(await nativeProof(neighbor), beforeNeighbor);
        assert.equal(await readFile(path.join(workspace.rootPath, trimmedPath), 'utf8'), 'The trimmed native neighbor is not the Guest target.');
      });
      await check('actual approved assets preserve leading spaces and bounded reads above 5MiB without choosing trimmed neighbors', async () => {
        const target = await seed(), assetPath = ` image-${crypto.randomUUID()}.png`, largePath = ` large-${crypto.randomUUID()}.png`;
        const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1kAAAAASUVORK5CYII=', 'base64');
        const large = Buffer.alloc(6 * 1024 * 1024); png.copy(large);
        const neighborBytes = Buffer.from('Trimmed image must stay private and unchanged.');
        await writeFile(path.join(workspace.rootPath, assetPath), png);
        await writeFile(path.join(workspace.rootPath, assetPath.trim()), neighborBytes);
        await writeFile(path.join(workspace.rootPath, largePath), large);
        const doc = new Y.Doc();
        try {
          doc.getText('content').insert(0, `![Exact](<${encodeURIComponent(assetPath)}>)\n\n![Large](<${encodeURIComponent(largePath)}>)`);
          await fixture.query('UPDATE collaboration_yjs_states SET yjs_state=$1,state_vector=$2 WHERE document_id=$3',
            [Buffer.from(Y.encodeStateAsUpdate(doc)), Buffer.from(Y.encodeStateVector(doc)), target.documentId]);
        } finally { doc.destroy(); }
        const input = await createInput(target), created = await guests.create(memberRequest(), input);
        assert.equal(created.assetCount, 2);
        await guests.challenge(created.id); const code = delivered.get(input.email); assert(code);
        const verified = await guests.verify(created.id, code, 'Exact image Guest');
        assert(Buffer.from(await guests.asset(created.id, verified.token, assetPath)).equals(png));
        assert(Buffer.from(await guests.asset(created.id, verified.token, largePath)).equals(large));
        await assert.rejects(guests.asset(created.id, verified.token, assetPath.trim()), error => Number(Reflect.get(error as object, 'status')) === 404);
        const replacement = path.join(workspace.rootPath, `replacement-${crypto.randomUUID()}.png`);
        await writeFile(replacement, png); await rename(replacement, path.join(workspace.rootPath, assetPath));
        await assert.rejects(guests.asset(created.id, verified.token, assetPath), error => Number(Reflect.get(error as object, 'status')) === 404);
        assert((await readFile(path.join(workspace.rootPath, assetPath.trim()))).equals(neighborBytes));
      });
      await check('actual member Drawing grant retains its separate Scene table and provider checks while Guest Create rejects it', async () => {
        const filePath = `drawing-${crypto.randomUUID()}.excalidraw`;
        await writeFile(path.join(workspace.rootPath,filePath),JSON.stringify({type:'excalidraw',version:2,
          elements:[],appState:{viewBackgroundColor:'#ffffff'},files:{}}));
        const { createCollaborationSessionGrant } = await import('../app/lib/collaboration/session-service');
        const { loadExcalidrawScene } = await import('../app/lib/excalidraw-collaboration/repository');
        const { issueCollaborationTicket, verifyCollaborationTicket } = await import('../app/lib/collaboration/ticket');
        const { resolveCollaborationSessionAccess } = await import('../app/lib/collaboration/connection-access');
        const grant = await createCollaborationSessionGrant({workspace,fileOptions:{workspace},
          request:{path:filePath,provider:'excalidraw',representation:'excalidraw_scene'}});
        assert.equal(grant.provider,'excalidraw'); assert.equal(grant.representation,'excalidraw_scene');
        const scene = await loadExcalidrawScene(grant.documentId); assert(scene);
        assert.equal(scene.path,filePath); assert.equal(scene.workspaceId,workspace.workspaceId);
        assert.equal(scene.organizationId,workspace.organizationId); assert.equal(scene.lifecycleGeneration,grant.lifecycleGeneration);
        assert.equal(scene.status,'active'); assert.deepEqual(scene.elements,[]);
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM collaboration_yjs_states WHERE document_id=$1',[grant.documentId])).rows[0].n),0);
        const signed = issueCollaborationTicket({userId:'owner',sessionId:'guest-fixture-owner-session',workspaceId:workspace.workspaceId,
          organizationId:workspace.organizationId ?? null,documentId:grant.documentId,path:filePath,
          provider:'excalidraw',representation:'excalidraw_scene',permission:'write',lifecycleGeneration:grant.lifecycleGeneration});
        assert.equal((await resolveCollaborationSessionAccess(verifyCollaborationTicket(signed.token))).user.id,'owner');
        const before = fingerprintRows((await fixture.query('SELECT * FROM collaboration_excalidraw_states WHERE document_id=$1',[grant.documentId])).rows);
        await assert.rejects(createCollaborationSessionGrant({workspace,fileOptions:{workspace},
          request:{path:filePath,provider:'yjs',representation:'plain_text'}}),error => Number(Reflect.get(error as object,'status')) === 409);
        const response = await fileInfo(new NextRequest(`http://localhost/api/files/info?${new URLSearchParams({path:filePath})}`,
          {headers:memberRequest().headers})); assert.equal(response.status,200);
        await assert.rejects(guests.create(memberRequest(),{workspaceId:workspace.workspaceId,path:filePath,
          expectedTarget:(await response.json()).data.metadataTarget,email:`guest-${crypto.randomUUID()}@redemption.invalid`,permission:'read',expiresAt:null}));
        assert.equal(Number((await fixture.query('SELECT count(*) AS n FROM file_guest_invitations WHERE document_id=$1',[grant.documentId])).rows[0].n),0);
        assert.equal(fingerprintRows((await fixture.query('SELECT * FROM collaboration_excalidraw_states WHERE document_id=$1',[grant.documentId])).rows),before);
      });
      await check('actual same-path Guest Readers overlap while the policy Writer remains exclusive and current rights recover', async () => {
        const target = await seed(), issued = await guests.verify(target.id,target.code,'Concurrent current Guest');
        const nativeBefore = await nativeProof(target), invitationBefore = fingerprintRows([await invitation(target.id)]);
        const sessionsBefore = fingerprintRows(await sessionRows(target.id));
        const firstLocked = signal(), releaseFirst = signal();
        const pending: Promise<unknown>[] = [];
        let firstClient: Client | undefined, secondClient: Client | undefined, writerClient: Client | undefined;
        let overlappingSharedLocks = false, checkingPolicyWriter = false, firstReleased = false;
        await observeQueries(query => {
          if (/^SELECT\s+pg_advisory_xact_lock(?:_shared)?\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/iu.test(query.sql)
            && query.values[0] === workspace.workspaceId && query.values[1] === target.filePath) {
            if (checkingPolicyWriter) { writerClient = query.client; return query.run(); }
            if (!firstClient) {
              firstClient = query.client;
              return afterRealQuery(query,async () => {
                firstLocked.resolve();
                await bounded(releaseFirst.promise,'The owned first Guest Reader was not released.');
                firstReleased = true;
              });
            }
            secondClient = query.client;
            assert.notEqual(secondClient,firstClient,'Concurrent Guest Readers must use actual distinct backends.');
            return afterRealQuery(query,async () => {
              const pids = [firstClient,secondClient].map(client => Number(Reflect.get(client!,'processID')));
              assert(pids.every(pid => Number.isSafeInteger(pid) && pid > 0));
              assert.notEqual(pids[0],pids[1]);
              const held = (await fixture.query(`SELECT pid,mode FROM pg_locks WHERE locktype='advisory' AND granted
                AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objsubid=2
                AND classid::bigint=(hashtext($2)::bigint & 4294967295)
                AND objid::bigint=(hashtext($3)::bigint & 4294967295) AND pid=ANY($1::int[])`,
              [pids,workspace.workspaceId,target.filePath])).rows as Array<{pid:number;mode:string}>;
              assert.equal(firstReleased,false,'The second Reader must acquire its actual lock before the first is released.');
              assert.equal(held.length,2); assert(held.every(row => row.mode === 'ShareLock'));
              overlappingSharedLocks = true;
            });
          }
          return query.run();
        },async () => {
          const first = guests.access(target.id,{token:issued.token}); pending.push(first); void first.catch(() => undefined);
          try {
            await bounded(firstLocked.promise,'The first actual Guest Reader never acquired its path lock.');
            const second = guests.access(target.id,{token:issued.token}); pending.push(second); void second.catch(() => undefined);
            const found = await bounded(second,'A second current Guest Reader must complete while the first Reader retains its path lock.');
            assert.equal(found.state.documentId,target.documentId); assert.equal(firstReleased,false); assert(overlappingSharedLocks);
            checkingPolicyWriter = true;
            await assert.rejects(guests.manage(memberRequest(),workspace.workspaceId,target.id,{policyRevision:1,permission:'read'}),
              error => {
                assert.equal(isFileGuestInvitationReaderBusy(error),false,'A real Member Writer conflict is outside the Reader classifier.');
                return Reflect.get(error as object,'code') === 'PRINCIPAL_BUSY';
              });
            assert(writerClient); assert.notEqual(writerClient,firstClient);
            assert.equal(fingerprintRows([await invitation(target.id)]),invitationBefore,'The blocked actual policy Writer cannot mutate the invitation.');
          } finally {
            releaseFirst.resolve();
            await Promise.allSettled(pending);
          }
          assert.equal((await first).state.documentId,target.documentId);
        });
        assert(overlappingSharedLocks); assert(firstReleased);
        assert.equal(fingerprintRows(await sessionRows(target.id)),sessionsBefore); assert.equal(await nativeProof(target),nativeBefore);
        const managed = await guests.manage(memberRequest(),workspace.workspaceId,target.id,{policyRevision:1,permission:'read'});
        assert.equal(managed.policyRevision,2); assert.equal(managed.permission,'read');
        const current = await guests.access(target.id,{token:issued.token});
        assert.equal(current.invitation.policyRevision,2); assert.equal(current.workspace.permissions.canWrite,false);
        assert.equal(current.state.documentId,target.documentId); assert.equal(await nativeProof(target),nativeBefore);
        assert.equal(fingerprintRows(await sessionRows(target.id)),sessionsBefore);
      });
      await check('actual Reader SQL contention rejects without permanent monitor denial; fresh rights pass and real revoke denies once', async () => {
        const target = await seed(), issued = await guests.verify(target.id,target.code,'Actual monitored Guest');
        const { fileGuestCollaborationSession } = await import('../app/lib/file-guests/collaboration');
        const { verifyCollaborationTicket } = await import('../app/lib/collaboration/ticket');
        const { revalidateCollaborationAccess } = await import('../app/lib/collaboration/connection-access');
        const { createCollaborationAccessMonitor } = await import('../app/lib/collaboration/access-monitor');
        const { WorkspaceRequestPrincipalError } = await import('../app/lib/workspaces/request-principal');
        const claims = verifyCollaborationTicket((await fileGuestCollaborationSession(target.id,issued.token)).token);
        const nativeBefore = await nativeProof(target), invitationBefore = fingerprintRows([await invitation(target.id)]);
        const sessionsBefore = fingerprintRows(await sessionRows(target.id));
        for (const fake of [undefined,null,{},new Error('PRINCIPAL_BUSY'),
          Object.assign(new Error('PRINCIPAL_BUSY'),{name:'WorkspaceRequestPrincipalError',code:'PRINCIPAL_BUSY'}),
          new WorkspaceRequestPrincipalError('PRINCIPAL_BUSY'),new FileGuestWriterCommitError()]) {
          assert.equal(isFileGuestInvitationReaderBusy(fake),false,'Only an actual Reader rollback marks its own error object.');
        }
        const blocker = new Client({connectionString,connectionTimeoutMillis:5000,
          options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-reader-monitor-blocker`});
        blocker.on('error',() => undefined);
        let holding = false, denials = 0, validations = 0, published = false;
        let readerClient: Client | undefined, originalRelease: ((error?:Error) => void) | undefined;
        let rolledBack = false, releases = 0, capturedBusy: unknown;
        const monitor = createCollaborationAccessMonitor<{claims:CollaborationTicketClaims}>({
          validate:async peer => { validations++; await revalidateCollaborationAccess(peer.claims); },
          isTransient:isFileGuestInvitationReaderBusy,deny:() => { denials++; },intervalMs:60_000,
        });
        const peer = {claims}, unregister = monitor.add(peer);
        try {
          await blocker.connect(); await blocker.query('BEGIN'); holding = true;
          await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[workspace.workspaceId,target.filePath]);
          await observeQueries(query => {
            if (/^SELECT\s+pg_advisory_xact_lock_shared\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/iu.test(query.sql)
              && query.values[0] === workspace.workspaceId && query.values[1] === target.filePath) {
              assert.equal(readerClient,undefined); readerClient = query.client;
              originalRelease = Reflect.get(query.client,'release') as (error?:Error) => void;
              assert.equal(typeof originalRelease,'function');
              Reflect.set(query.client,'release',(error?:Error) => {
                const result = Reflect.apply(originalRelease!,query.client,[error]); releases++; return result;
              });
            }
            if (readerClient === query.client && query.sql === 'ROLLBACK') return afterRealQuery(query,() => { rolledBack = true; });
            return query.run();
          },async () => {
            await assert.rejects(monitor.check(peer).then(() => { published = true; }),error => {
              assert(error instanceof WorkspaceRequestPrincipalError); assert.equal(error.code,'PRINCIPAL_BUSY');
              assert.equal(isFileGuestInvitationReaderBusy(error),true); assert(rolledBack); assert.equal(releases,1);
              capturedBusy = error; return true;
            });
          });
          assert(readerClient); assert(capturedBusy); assert.equal(published,false); assert.equal(denials,0); assert.equal(validations,1);
          if (readerClient && originalRelease) Reflect.set(readerClient,'release',originalRelease);
          originalRelease = undefined;
          assert.equal(fingerprintRows([await invitation(target.id)]),invitationBefore);
          assert.equal(fingerprintRows(await sessionRows(target.id)),sessionsBefore); assert.equal(await nativeProof(target),nativeBefore);
          await blocker.query('ROLLBACK'); holding = false;
          await monitor.check(peer); assert.equal(validations,2); assert.equal(denials,0);
          assert.equal(isFileGuestInvitationReaderBusy(capturedBusy),true);
          await guests.manage(memberRequest(),workspace.workspaceId,target.id,{policyRevision:1,revoke:true});
          await assert.rejects(monitor.check(peer),error => {
            assert.equal(isFileGuestInvitationReaderBusy(error),false); return true;
          });
          assert.equal(validations,3); assert.equal(denials,1);
          await assert.rejects(monitor.check(peer)); assert.equal(validations,3); assert.equal(denials,1);
          assert.equal((await invitation(target.id)).status,'revoked');
          assert.equal(await nativeProof(target),nativeBefore); assert.equal(fingerprintRows(await sessionRows(target.id)),sessionsBefore);
        } finally {
          if (readerClient && originalRelease) Reflect.set(readerClient,'release',originalRelease);
          if (holding) await blocker.query('ROLLBACK').catch(() => undefined);
          await blocker.end().catch(() => undefined);
          await unregister(); await monitor.dispose();
        }
      });
      const { WorkspaceRequestPrincipalError, withFileGuestInvitationAuthority, withFileGuestInvitationAuthorityOnConnection }
        = await import('../app/lib/workspaces/request-principal');
      const { executeLifecycleTransaction } = await import('../app/lib/collaboration/lifecycle-transaction');
      const { readFileGuestNativeTargetOnConnection } = await import('../app/lib/file-guests/target');
      const { withWorkspaceSideEffectWriterFenceOnConnection } = await import('../app/lib/files/workspace-side-effect-writer-fence');
      const { fileGuestErrorResponse } = await import('../app/lib/file-guests/http');
      for (const family of ['access','verify','swallowed-authority'] as const)
      for (const fault of family === 'swallowed-authority' ? ['clean'] as const : ['clean','rollback-ack-loss','release-throws'] as const)
      await check(`actual ${family} SQL busy preserves ${fault} cleanup precedence without publication`, async () => {
        const target = await seed(), issued = await guests.verify(target.id,target.code,'Before actual cleanup fault');
        const nativeBefore = await nativeProof(target), invitationBefore = fingerprintRows([await invitation(target.id)]);
        const sessionsBefore = fingerprintRows(await sessionRows(target.id));
        const blocker = new Client({connectionString,connectionTimeoutMillis:5000,
          options:`-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-cleanup-precedence-blocker`});
        blocker.on('error',() => undefined);
        const rollbackAck = new Error('Owned real rollback acknowledgement delivery failed.');
        const releaseError = new Error('Owned actual checkout release acknowledgement failed.');
        let holding = false, published = false, rolledBack = false, released = false, discarded = false;
        let lockAttempts = 0, rollbacks = 0, commits = 0, disposals = 0, dml = 0, pid = 0;
        let sqlFailure: unknown, swallowedBusy: unknown, reader: Client | undefined;
        let originalRelease: ((error?:Error) => void) | undefined;
        try {
          await blocker.connect(); await blocker.query('BEGIN'); holding = true;
          await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[workspace.workspaceId,target.filePath]);
          await observeQueries(query => {
            if (/^SELECT\s+pg_advisory_xact_lock(?:_shared)?\(hashtext\(\$1\),\s*hashtext\(\$2\)\)/iu.test(query.sql)
              && query.values[0] === workspace.workspaceId && query.values[1] === target.filePath) {
              lockAttempts++; assert.equal(reader,undefined); reader = query.client;
              pid = Number(Reflect.get(query.client,'processID')); assert(Number.isSafeInteger(pid) && pid > 0);
              originalRelease = Reflect.get(query.client,'release') as (error?:Error) => void;
              assert.equal(typeof originalRelease,'function');
              Reflect.set(query.client,'release',(error?:Error) => {
                disposals++; discarded = error instanceof Error;
                const result = Reflect.apply(originalRelease!,query.client,[error]); released = true;
                if (fault === 'release-throws') throw releaseError;
                return result;
              });
              // openDb's actual query path uses the real pg Promise result.
              // Only observe the genuine lock rejection; do not synthesize it.
              assert.notEqual(typeof query.args.at(-1),'function');
              return Promise.resolve(query.run()).catch(error => {
                assert.equal(Reflect.get(error as object,'code'),'55P03'); sqlFailure = error; throw error;
              });
            }
            if (reader === query.client) {
              if (/^(INSERT|UPDATE|DELETE)\b/iu.test(query.sql)) dml++;
              if (query.sql === 'COMMIT') commits++;
              if (query.sql === 'ROLLBACK') {
                rollbacks++;
                return afterRealQuery(query,() => {
                  rolledBack = true;
                  if (fault === 'rollback-ack-loss') throw rollbackAck;
                });
              }
            }
            return query.run();
          },async () => {
            const operation = family === 'access' ? guests.access(target.id,{token:issued.token})
              : family === 'verify' ? guests.verify(target.id,target.code,'Actual blocked redemption')
                : withFileGuestInvitationAuthority(target.id,'access',async authority => {
                  try {
                    await executeLifecycleTransaction<unknown>({openConnection:database.openDb,
                      execute:async connection => {
                        await connection.run('SET TRANSACTION ISOLATION LEVEL READ COMMITTED READ WRITE');
                        return withFileGuestInvitationAuthorityOnConnection(connection,authority,async access => {
                          const actual = await readFileGuestNativeTargetOnConnection(connection,access.workspace,access.invitation);
                          return withWorkspaceSideEffectWriterFenceOnConnection(connection,{workspace:access.workspace,targets:[actual]},() =>
                            connection.get('SELECT pg_advisory_xact_lock_shared(hashtext($1), hashtext($2))',
                              [access.workspace.workspaceId,actual.path]) as Promise<unknown>);
                        });
                      },recoverCommitted:async () => assert.fail('A rejected authority phase must never reach COMMIT recovery.')});
                  } catch (error) {
                    assert(error instanceof WorkspaceRequestPrincipalError); assert.equal(error.code,'PRINCIPAL_BUSY');
                    swallowedBusy = error;
                  }
                  return 'A swallowed authorization failure must not publish this value.';
                });
            let rejection: unknown;
            await assert.rejects(operation.then(() => { published = true; }),error => {
              rejection = error;
              assert(sqlFailure); assert(rolledBack); assert(released);
              if (fault === 'rollback-ack-loss') {
                assert(error instanceof AggregateError,'The actual lifecycle rollback AggregateError must outrank the earlier poisoned busy error.');
                assert.equal(error.errors.length,2); assert(error.errors[0] instanceof WorkspaceRequestPrincipalError);
                assert.equal(error.errors[0].code,'PRINCIPAL_BUSY'); assert.equal(error.errors[1],rollbackAck);
              } else if (fault === 'release-throws') assert.equal(error,releaseError,'The actual release failure object must survive the outer authority wrapper.');
              else {
                assert(error instanceof WorkspaceRequestPrincipalError); assert.equal(error.code,'PRINCIPAL_BUSY');
                if (family === 'swallowed-authority') assert.equal(error,swallowedBusy);
              }
              assert.equal(isFileGuestInvitationReaderBusy(error),family === 'access' && fault === 'clean');
              return true;
            });
            const response = fileGuestErrorResponse(rejection);
            assert.equal(response.headers.get('set-cookie'),null); assert.equal((await response.json()).success,false);
            if (fault === 'clean') assert.equal(response.status,409);
            else { assert.notEqual(response.status,409); assert(response.status >= 500); }
          });
          assert.equal(published,false); assert.equal(lockAttempts,1); assert.equal(rollbacks,1);
          assert.equal(commits,0); assert.equal(disposals,1); assert.equal(dml,0);
          assert.equal(discarded,fault === 'rollback-ack-loss');
          if (discarded) await waitFor(async () => (await fixture.query(
            'SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS absent',[pid])).rows[0].absent === true,
          'The actually discarded cleanup-fault backend remained present.');
          else await waitFor(async () => (await fixture.query(
            "SELECT NOT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND (state<>'idle' OR xact_start IS NOT NULL)) AS idle",[pid])).rows[0].idle === true,
          'The genuinely released checkout retained an active transaction.');
          assert.equal(fingerprintRows([await invitation(target.id)]),invitationBefore);
          assert.equal(fingerprintRows(await sessionRows(target.id)),sessionsBefore); assert.equal(await nativeProof(target),nativeBefore);
          if (reader && originalRelease) Reflect.set(reader,'release',originalRelease);
          originalRelease = undefined;
          await blocker.query('ROLLBACK'); holding = false;
          assert.equal((await guests.access(target.id,{token:issued.token})).state.documentId,target.documentId);
        } finally {
          if (reader && originalRelease) Reflect.set(reader,'release',originalRelease);
          if (holding) await blocker.query('ROLLBACK').catch(() => undefined);
          await blocker.end().catch(() => undefined);
        }
      });
      assert.equal(cases, 44);
      assert.equal(networkCalls, 0);
      passedFamilies = cases;
    } finally { Object.assign(fileGuestService, originalService); }
  } finally {
    Client.prototype.query = originalClientQuery;
    globalThis.fetch = originalFetch;
    await closeRuntime?.(); await admin?.end().catch(() => undefined);
    if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
    await control.end().catch(() => undefined);
    await rm(dataRoot, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
  }
}

void main().then(() => {
  completed = true;
  console.log(`file-guest-redemption-postgres-test: ${passedFamilies} actual PG18 Guest service families passed after cleanup, including the original eleven redemption families.`);
}, error => {
  completed = true;
  console.error(`Guest redemption fixture failed during: ${stage}`);
  console.error(error instanceof Error ? { name: error.name, message: error.message } : 'Unknown Guest fixture failure.');
  process.exitCode = 1;
});
