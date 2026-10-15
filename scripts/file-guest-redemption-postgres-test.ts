import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'dotenv';
import { Client } from 'pg';
import { NextRequest } from 'next/server';
import * as Y from 'yjs';

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
    const { readPostgresWorkspaceForActor } = await import('../app/lib/workspaces/postgres-runtime');
    const workspace = await readPostgresWorkspaceForActor({ userId: 'owner', role: 'admin' }, 'redemption-space');
    assert(workspace); assert.equal(workspace.workspaceId, 'redemption-space');
    assert.equal(workspace.permissions.canCreatePublicLinks, true); assert.equal(workspace.permissions.canWrite, true);
    assert(workspace.rootPath.startsWith(`${dataRoot}${path.sep}`)); await mkdir(workspace.rootPath, { recursive: true });
    const { createFileGuestService, fileGuestService } = await import('../app/lib/file-guests/service');
    const delivered = new Map<string, string>();
    const guests = createFileGuestService({ assertEntitlement: async () => undefined,
      sendCode: async input => { assert.match(input.email, /^guest-[a-f0-9-]+@redemption\.invalid$/u); delivered.set(input.email, input.code); } });
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
        VALUES($1,'redemption-space','redemption-org',$2,'plain_text',1,1,$3,$4,7,100,7,100,'fixture','fixture','lf',0,0,'active')`, [documentId, filePath, update!, vector!]);
      await fixture.query(`INSERT INTO file_guest_invitations(id,workspace_id,path,document_id,email,permission,status,policy_revision,created_by_user_id,assets_json,created_at,updated_at)
        VALUES($1,'redemption-space',$2,$3,$4,'write','active',1,'owner','[]',$5,$5)`, [id, filePath, documentId, email, Date.now()]);
      await guests.challenge(id);
      const code = delivered.get(email); assert(code); assert.match(code, /^\d{6}$/u);
      const state = (await fixture.query('SELECT challenge_hash,challenge_attempts,policy_revision FROM file_guest_invitations WHERE id=$1', [id])).rows[0];
      assert.equal(typeof state.challenge_hash, 'string'); assert.equal(Number(state.challenge_attempts), 0);
      return { id, documentId, filePath, code, challengeHash: state.challenge_hash as string };
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
        let paused = false, preparationPid = 0, managerPid = 0;
        let pending: PromiseSettledResult<Awaited<ReturnType<typeof guests.verify>>>[] | undefined;
        let verification: Promise<PromiseSettledResult<Awaited<ReturnType<typeof guests.verify>>>[]> | undefined;
        await observeQueries(query => {
          if (!paused && /^SELECT\b/iu.test(query.sql) && /\bFROM\s+"?file_guest_invitations"?\b/iu.test(query.sql) && query.values.includes(target.id)) {
            paused = true; preparationPid = Number(Reflect.get(query.client, 'processID'));
            return afterRealQuery(query, async result => {
              assert.equal(Reflect.get(result as object, 'rowCount'), 1); read.resolve();
              await bounded(release.promise, 'The old actual invitation result was not released.');
            });
          }
          if (/^UPDATE\s+"?file_guest_invitations"?/iu.test(query.sql) && query.values.includes(target.id)
            && /policy_revision/iu.test(query.sql)) managerPid = Number(Reflect.get(query.client, 'processID'));
          return query.run();
        }, async () => {
          verification = Promise.allSettled([guests.verify(target.id, target.code, 'Stale policy')]);
          try {
            await bounded(read.promise, 'The actual pre-transaction invitation read never completed.');
            const changed = await guests.manage(workspace, target.id, { policyRevision: 1, permission: 'read' });
            assert.equal(changed.policyRevision, 2);
          } finally { release.resolve(); }
          pending = await verification;
        }).finally(async () => { release.resolve(); await verification; });
        assert(paused); assert(preparationPid > 0); assert(managerPid > 0); assert.notEqual(preparationPid, managerPid);
        assert.equal(pending?.[0].status, 'rejected');
        if (pending?.[0].status === 'rejected') assert.equal(Reflect.get(pending[0].reason as object, 'status'), 409);
        const after = await invitation(target.id); assert.equal(after.challenge_hash === target.challengeHash, true);
        assert.equal(Number(after.challenge_attempts), 0); assert.equal((await sessionRows(target.id)).length, 0);
      });
      for (const expiry of ['challenge', 'invitation'] as const)
      await check(`actual ${expiry} expiry during a proven row-lock wait cannot extend redemption`, async () => {
        const target = await seed();
        const blocker = new Client({ connectionString, connectionTimeoutMillis: 5000,
          options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c application_name=guest-redemption-expiry-blocker` });
        blocker.on('error', () => undefined);
        let holding = false, writerPid = 0, expiryAt = 0, crossedAt = 0;
        let verification: Promise<PromiseSettledResult<Response>[]> | undefined;
        let responses: PromiseSettledResult<Response>[] | undefined;
        try {
          await blocker.connect(); await blocker.query('BEGIN'); holding = true;
          await blocker.query('SELECT id FROM file_guest_invitations WHERE id=$1 FOR UPDATE', [target.id]);
          const blockerPid = Number((await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
          await observeQueries(query => {
            if (query.client !== blocker && /^SELECT\b/iu.test(query.sql) && /\bfile_guest_invitations\b/iu.test(query.sql)
              && /\bFOR UPDATE\b/iu.test(query.sql) && query.values.includes(target.id)) {
              assert.equal(writerPid, 0, 'This expiry case must use one actual redemption writer.');
              writerPid = Number(Reflect.get(query.client, 'processID'));
            }
            return query.run();
          }, async () => {
            verification = Promise.allSettled([action(target.id, target.code, `Waited ${expiry} expiry`)]);
            try {
              const blocked = async () => writerPid > 0 && (await fixture.query(
                'SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked', [writerPid, blockerPid])).rows[0].blocked === true;
              await waitFor(blocked, 'The actual Guest writer never waited on the owned invitation row lock.');
              assert.notEqual(writerPid, blockerPid); assert(holding);
              expiryAt = Date.now() + 100;
              if (expiry === 'challenge') await blocker.query('UPDATE file_guest_invitations SET challenge_expires_at=$1 WHERE id=$2', [expiryAt, target.id]);
              else await blocker.query('UPDATE file_guest_invitations SET expires_at=$1 WHERE id=$2', [expiryAt, target.id]);
              await waitFor(async () => Date.now() > expiryAt && await blocked(),
                'The real expiry deadline was not crossed while the genuine writer remained blocked.');
              crossedAt = Date.now(); assert(crossedAt > expiryAt); assert(holding);
              await blocker.query('COMMIT'); holding = false;
              responses = await verification;
              console.log('Actual Guest row-lock expiry witness:', JSON.stringify({ expiry, blockerPid, writerPid, expiryAt, crossedAt }));
            } finally {
              if (holding) { await blocker.query('ROLLBACK'); holding = false; }
              await verification;
            }
          });
          assert.equal(responses?.[0].status, 'fulfilled');
          if (responses?.[0].status === 'fulfilled') {
            assert.equal(responses[0].value.status, expiry === 'challenge' ? 401 : 410);
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
            const payload = await response.json(); assert.equal(payload.code, 'FILE_GUEST_REDEMPTION_COMMIT_UNCONFIRMED');
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
            const payload = await response.json(); assert.equal(payload.code, 'FILE_GUEST_REDEMPTION_COMMIT_UNCONFIRMED');
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
      assert.equal(cases, 11); assert.equal(networkCalls, 0);
      console.log(`file-guest-redemption-postgres-test: ${cases} actual PG18 redemption families passed; Guest shared fences remain out of scope.`);
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

void main().catch(error => {
  console.error(`Guest redemption fixture failed during: ${stage}`);
  console.error(error instanceof Error ? { name: error.name, message: error.message } : 'Unknown Guest fixture failure.');
  process.exitCode = 1;
});
