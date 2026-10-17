import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import io, { type BigIntStats, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serialize } from 'node:v8';
import { parse } from 'dotenv';
import { Client, type Pool, type PoolClient, type QueryResult } from 'pg';
import { NextRequest } from 'next/server';
import { serializeSignedCookie } from 'better-call';
import type { SqlConnection } from '../app/lib/db';
import type { WorkspaceOperationCopyOrigin } from '../app/lib/files/workspace-operation-copy-origin';
import type { AgentExecutionContext } from '../app/lib/pi/agent-execution-context';
import type { WorkspaceContext } from '../app/lib/workspaces/types';
import type { PersistedCollaborationState } from '../app/lib/collaboration/persistence';
import type { NativeCopyReceipt } from '../app/lib/collaboration/native-copy-persistence';
import type { WorkspaceOperationNativeCopyPlan } from '../app/lib/files/workspace-operation-native-copy-plan';
import type { WorkspaceOperationNativeCopyStage } from '../app/lib/files/workspace-operation-native-copy-stage';
import type { JSONContent } from '@tiptap/core';

// Genuine, standalone PG18 auth fixture. Only its private schema and generated
// DATA are changed. No principal, license, invocation or authority DTO is mocked.
const privateEnvironment = '/Users/frankalexanderweber/.local/state/canvas-local-team-seat/notebook-host-dev.env';
let stage = 'private configuration', complete = false;
const domainFailure = (error: unknown): boolean => {
  if (!(error instanceof Error) || error instanceof assert.AssertionError || error instanceof TypeError || error instanceof SyntaxError) return false;
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string' && /^(PRINCIPAL_|COPY_ORIGIN_|AGENT_TOOL_INVOCATION_|SEAT_)|^AGENT_ACTOR_CONTEXT_DENIED$/u.test(code)) return true;
  return error.constructor === Error && (code === undefined || code === 'WORKSPACE_PERMISSION_DENIED') && [
    'The originating agent session is unavailable in this workspace.', 'Workspace not found or inaccessible.',
    'Agent access is no longer available in this workspace.', 'Workspace permission denied',
  ].includes(error.message);
};
process.once('beforeExit', () => { if (!complete) process.exitCode = 1; });

function ownerDiagnostic(error: unknown): Record<string, unknown> {
  const seen = new Set<unknown>(); let remaining = 12;
  const redact = (text: string) => text
    .replace(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, '[jwt-redacted]')
    .replace(/[a-f0-9]{32,}/giu, '[long-hex-redacted]')
    .replace(/\b(password|secret|token|authorization)\s*[=:]\s*\S+/giu, '$1=[redacted]')
    .slice(0, 600);
  const visit = (value: unknown, depth: number): Record<string, unknown> => {
    if (!(value instanceof Error)) return { name: 'NonError', type: typeof value };
    if (seen.has(value) || depth > 3 || remaining-- <= 0) return { name: 'DiagnosticBound' };
    seen.add(value);
    const code = Object.getOwnPropertyDescriptor(value, 'code')?.value;
    const result: Record<string, unknown> = { name: redact(value.name).slice(0, 80),
      code: typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/u.test(code) ? code : null, message: redact(value.message) };
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && Object.hasOwn(cause, 'value')) result.cause = visit(cause.value, depth + 1);
    const errors = Object.getOwnPropertyDescriptor(value, 'errors');
    if (errors && Object.hasOwn(errors, 'value') && Array.isArray(errors.value)) {
      result.errors = errors.value.slice(0, 6).map(child => visit(child, depth + 1));
    }
    return result;
  };
  return visit(error, 0);
}

async function runWorkspaceNativeCopyOwnerPostgresFixture(): Promise<void> {
  const sourceFiles = ['scripts/workspace-operation-native-copy-owner-postgres-test.ts',
    'app/lib/files/workspace-operation-native-copy-owner.ts', 'app/lib/files/workspace-operation-native-copy-phase.ts',
    'app/lib/files/workspace-operation-native-copy-phase-contract.ts', 'app/lib/files/workspace-operation-native-copy-phase-read.ts',
    'app/lib/files/workspace-operation-staging.ts', 'app/lib/files/workspace-operation-native-copy-stage.ts',
    'app/lib/files/workspace-operation-native-copy-plan.ts', 'app/lib/files/workspace-operation-native-copy-graph.ts',
    'app/lib/files/workspace-operation-journal.ts', 'app/lib/workspaces/copy-principal.ts',
    'app/lib/collaboration/native-copy-persistence.ts', 'app/lib/markdown/native-link-mutation-persistence.ts',
    'app/lib/markdown/workspace-native-copy-link-updates.ts', 'app/lib/markdown/workspace-source-authority-stage.ts',
    'app/lib/filesystem/prepared-workspace-path-copy.ts', 'app/lib/filesystem/prepared-workspace-path-copy-contract.ts',
    'app/lib/workspaces/postgres-runtime.ts', 'app/lib/collaboration/native-text-session-activation.ts',
    'app/lib/workspaces/starter-document.ts', 'app/lib/workspaces/starter-document-initialization-api.ts',
    'app/lib/workspaces/starter-document-initialization.ts', 'app/lib/workspaces/starter-document-initialization-store.ts',
    'app/lib/workspaces/starter-document-initialization-contract.ts', 'app/lib/collaboration/markdown-file-import.ts',
    'app/lib/collaboration/markdown-file-import-persistence.ts', 'app/lib/db/markdown-file-import-migration.ts',
    'app/lib/collaboration/native-session-state-reader.ts',
    'app/lib/collaboration/room-admission-contract.ts', 'app/lib/collaboration/room-admission-outcome.ts',
    'app/lib/collaboration/room-admission-handoff.ts',
    'app/lib/files/fd-publication.ts', 'tools/native-fs/fd-publication.c', 'scripts/build-fd-publication.mjs',
    `native/fd-publication/${process.platform}-${process.arch}/manifest.json`,
    `native/fd-publication/${process.platform}-${process.arch}/fd-publication.node`];
  const sourcePins = Object.fromEntries(await Promise.all(sourceFiles.map(async filename =>
    [filename, crypto.createHash('sha256').update(await readFile(filename)).digest('hex')])));
  assert.equal(process.env.NODE_ENV, 'test');
  assert.notEqual(process.env.CANVAS_LEGACY_EPOCH_TIMESTAMP_UNIT?.trim().toLowerCase(), 'seconds');
  assert.notEqual(process.env.CANVAS_POSTGRES_VECTOR_ENABLED, 'true');
  assert.equal((await stat(privateEnvironment)).mode & 0o077, 0);
  const connectionString = parse(await readFile(privateEnvironment, 'utf8')).DATABASE_URL; assert(connectionString);
  const url = new URL(connectionString);
  assert(['postgres:', 'postgresql:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname));
  assert.equal(url.port, '55433'); assert.equal(url.pathname, '/canvas_notebook'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  const schema = `copy_owner_${crypto.randomUUID().replaceAll('-', '')}`;
  assert.match(schema, /^copy_owner_[a-f0-9]{32}$/u);
  const applicationName = `copy-owner-${crypto.randomUUID().replaceAll('-', '')}`;
  const environment = { ...process.env }, originalFetch = globalThis.fetch;
  const dataRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'canvas-copy-owner-'))), dataIdentity = await lstat(dataRoot);
  assert.equal(dataIdentity.uid, process.getuid!()); assert.equal(dataIdentity.mode & 0o077, 0);
  const control = new Client({ connectionString, connectionTimeoutMillis: 5000,
    options: '-c statement_timeout=15000', application_name: `${applicationName}-admin` });
  const clients = new Set<Client>();
  let created = false, schemaOid: string | undefined, pool: { end: () => Promise<void> } | undefined;
  let groups = 0, fetches = 0, opened = 0, closed = 0, failed = false, primary: unknown;
  const restorers: Array<() => void> = [];
  const actualFstat = io.fstatSync.bind(io);
  const observedNodes = new Set<string>();
  const nodeKey = (info: BigIntStats) => `${info.dev}:${info.ino}`;
  const existingSources = new Map<string, string>();
  const ownClient = async () => {
    const client = new Client({ connectionString, connectionTimeoutMillis: 5000, application_name: applicationName,
      options: `-c search_path=${schema},pg_catalog -c statement_timeout=15000 -c lock_timeout=100` });
    client.on('error', () => undefined); // A genuine PG18 transaction timeout may close this owned client.
    clients.add(client); opened++; await client.connect(); return client;
  };
  const endClient = async (client: Client) => { await client.end(); if (clients.delete(client)) closed++; };
  const check = async (name: string, operation: () => Promise<void>) => {
    stage = name; await operation(); groups++; console.log(`PASS native-copy-owner ${groups}: ${name}`);
  };
  try {
    await control.connect();
    assert.equal(Math.floor(Number((await control.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000), 18);
    await control.query(`CREATE SCHEMA "${schema}"`); created = true;
    await control.query(`COMMENT ON SCHEMA "${schema}" IS '${applicationName}'`);
    const identity = (await control.query('SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
    assert.equal(identity.owned, true); schemaOid = identity.oid;
    console.log(JSON.stringify({ fixture: 'workspace-native-copy-owner', schema, schemaOid, applicationName, dataRoot, pid: process.pid, sourcePins }));
    Object.assign(process.env, { DATABASE_URL: connectionString, PGOPTIONS: `-c search_path=${schema},pg_catalog -c statement_timeout=15000`, PGAPPNAME: applicationName,
      CANVAS_DATABASE_PROVIDER: 'postgres', DATA: dataRoot, CANVAS_DATA_ROOT: dataRoot, CANVAS_INSTANCE_ID: `fixture-${crypto.randomUUID()}`,
      BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('hex'), BETTER_AUTH_BASE_URL: 'http://localhost', AUTH_COOKIE_SECURE: 'false',
      CANVAS_TEST_NATIVE_TEXT_SESSION: '1',
      CANVAS_MCP_DIRECT_ENABLED: 'false', CANVAS_ORGANIZATION_ID: 'principal-org', CANVAS_DEPLOYMENT_MODE: 'team', CANVAS_TEAM_FEATURES_ENABLED: 'true',
      CANVAS_LICENSE_RUNTIME_ENVIRONMENT: 'production', CANVAS_LICENSE_CONTROL_PLANE_URL: 'https://control.example.test' });
    for (const key of ['BOOTSTRAP_ADMIN_EMAIL', 'CANVAS_LICENSE_TEST_PUBLIC_KEY', 'CANVAS_LICENSE_TEST_TRUSTED_PUBLIC_KEY_FINGERPRINTS', 'NEXT_PHASE']) delete process.env[key];
    const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const fingerprint = crypto.createHash('sha256').update(keys.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    process.env.CANVAS_LICENSE_PUBLIC_KEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    process.env.CANVAS_LICENSE_TRUSTED_PUBLIC_KEY_FINGERPRINTS = fingerprint;
    const seconds = Math.floor(Date.now() / 1000);
    const claims = { protocolVersion: 'canvas-team-seat-protocol-v1', licenseId: 'copy-owner-license', sub: process.env.CANVAS_INSTANCE_ID,
      instanceId: process.env.CANVAS_INSTANCE_ID, iss: 'canvas-control-plane', aud: 'canvas-notebook', plan: 'community', status: 'active',
      hostingMode: 'community', edition: 'team', licenseClass: 'commercial', licenseEnvironment: 'production', nonBillable: false,
      seatLimit: 2, quotas: { users: 2 }, entitlementsVersion: 6, iat: seconds - 60, exp: seconds + 3600 };
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: fingerprint.slice(0, 16) })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    process.env.CANVAS_LICENSE_CERT = `${header}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.privateKey).toString('base64url')}`;
    globalThis.fetch = async () => { fetches++; throw new Error('Network use is forbidden in this owned fixture.'); };
    stage = 'actual full migrations';
    const { runPostgresMigrations } = await import('../app/lib/db/postgres');
    const admin = await ownClient();
    await runPostgresMigrations({ query: async (sql: string, values?: unknown[]) => {
      const before = (await admin.query("SELECT current_schema() AS schema,current_setting('search_path') AS path")).rows[0];
      assert.equal(before.schema, schema); assert.deepEqual(before.path.split(',').map((v: string) => v.trim()), [schema, 'pg_catalog']);
      const result = await admin.query(sql, values);
      assert.equal((await admin.query('SELECT current_schema() AS schema')).rows[0].schema, schema); return result;
    } } as unknown as Parameters<typeof runPostgresMigrations>[0]);
    const { getPostgresRuntimeQueryable } = await import('../app/lib/db');
    const runtime = getPostgresRuntimeQueryable(); assert(runtime); pool = runtime as typeof pool;
    assert.equal((await runtime.query('SELECT current_schema() AS schema')).rows[0].schema, schema);
    const { getLicenseStatus } = await import('../app/lib/license');
    const { verifyLicenseJwtDetailed } = await import('../app/lib/license/jwt');
    assert.equal((await verifyLicenseJwtDetailed(process.env.CANVAS_LICENSE_CERT!, process.env.CANVAS_INSTANCE_ID!)).ok, true);
    const license = await getLicenseStatus(); assert.equal(license.licensed, true); assert.equal(license.edition, 'team'); assert.equal(license.seatLimit, 2);
    const now = Date.now();
    await admin.query(`INSERT INTO "user"(id,name,email,email_verified,role,banned,created_at,updated_at)
      VALUES('owner','Owner','owner@principal.test',1,'admin',0,$1,$1),('member','Member','member@principal.test',1,'user',0,$1,$1),
      ('inactive','Inactive','inactive@principal.test',1,'user',0,$1,$1)`, [now]);
    await admin.query(`INSERT INTO canvas_organization_settings(organization_id,owner_user_id,deployment_mode,team_features_enabled,created_at,updated_at)
      VALUES('principal-org','owner','team',1,100,100)`);
    await admin.query(`INSERT INTO organization_user_permissions(organization_id,user_id,role,status,can_write_team_workspace,created_at,updated_at)
      VALUES('principal-org','owner','owner','active',1,100,100),('principal-org','member','member','active',0,100,100),
      ('principal-org','inactive','member','disabled',0,100,100)`);
    await admin.query(`INSERT INTO team_memberships(id,organization_id,candidate_email,user_id,role,status,accepted_at,activated_at,created_at,updated_at)
      VALUES('owner-seat','principal-org','owner@principal.test','owner','owner','active',100,100,100,100),
      ('member-seat','principal-org','member@principal.test','member','member','active',100,200,100,100),
      ('inactive-seat','principal-org','inactive@principal.test','inactive','member','suspended',100,50,100,100)`);
    await admin.query("INSERT INTO team_membership_sync_state(organization_id,created_at,updated_at) VALUES('principal-org',100,100)");
    const { createPostgresWorkspaceForActor, upsertPostgresWorkspaceMemberForActor, readPostgresWorkspaceForActorOnConnection } = await import('../app/lib/workspaces/postgres-runtime');
    const { resolveWorkspaceActor } = await import('../app/lib/workspaces/context');
    const actor = (userId = 'member') => resolveWorkspaceActor({ id: userId, role: userId === 'owner' ? 'admin' : 'user', email: `${userId}@principal.test` });
    const sourceOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Copy principal read source' });
    const destinationOwner = await createPostgresWorkspaceForActor(actor('owner'), { type: 'team', name: 'Copy principal write destination' });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), sourceOwner.workspaceId, { userId: 'member', canRead: true, canWrite: false, canManage: false });
    await upsertPostgresWorkspaceMemberForActor(actor('owner'), destinationOwner.workspaceId, { userId: 'member', canRead: true, canWrite: true, canManage: false });
    const rawConnection = (client: Client): SqlConnection => ({
      get: async (sql, values) => (await client.query(sql, values)).rows[0], all: async (sql, values) => (await client.query(sql, values)).rows,
      run: async (sql, values) => ({ changes: (await client.query(sql, values)).rowCount ?? 0 }), close: () => assert.fail('Caller connection was closed.'),
    });
    const workspace = async (id: string, userId = 'member') => {
      const value = await readPostgresWorkspaceForActorOnConnection(rawConnection(admin), actor(userId), id); assert(value); return value;
    };
    const source = await workspace(sourceOwner.workspaceId), destination = await workspace(destinationOwner.workspaceId);
    assert.equal(source.permissions.canRead, true); assert.equal(source.permissions.canWrite, false); assert.equal(destination.permissions.canWrite, true);
    const tokens = new Map<string, string>();
    for (const userId of ['owner', 'member']) {
      const token = crypto.randomBytes(32).toString('hex'); tokens.set(userId, token);
      await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
        [`session-${userId}`, token, userId, now + 3600000, now]);
    }
    await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$5)',
      ['original-member-session', crypto.randomBytes(32).toString('hex'), 'member', now - 1000, now - 7200000]);
    const request = async (cookie = false, userId = 'member', selected = source) => {
      const token = tokens.get(userId); assert(token);
      const headers = new Headers({ 'x-canvas-workspace-id': selected.workspaceId });
      if (cookie) headers.set('cookie', (await serializeSignedCookie('better-auth.session_token', token, process.env.BETTER_AUTH_SECRET!)).split(';')[0]);
      else headers.set('authorization', `Bearer ${token}`);
      return new NextRequest('http://localhost/api/files/copy', { method: 'POST', headers });
    };
    const { auth } = await import('../app/lib/auth');
    const { captureWorkspaceOperationCopyOrigin } = await import('../app/lib/files/workspace-operation-copy-origin');
    let currentMemberSessionId = 'session-member';
    const memberOrigin = (a = source, b = destination) => captureWorkspaceOperationCopyOrigin({
      actor: { type: 'user', userId: 'member', actorId: 'member', sessionId: currentMemberSessionId }, sourceWorkspace: a, destinationWorkspace: b,
    });
    const db = await import('../app/lib/db');
    const { previewWorkspaceNativeCopyOperation: preview, executeWorkspaceNativeCopyOperation: execute } = await import('../app/lib/files/workspace-operation-native-copy-owner');
    const { Y } = await import('../app/lib/collaboration/server-runtime');
    const { createPlainTextYDoc, createRichMarkdownYDoc } = await import('../app/lib/collaboration/markdown-state');
    const { nativeRichDocumentFixture } = await import('./helpers/rich-markdown-projection-fixtures');
    const { loadCollaborationStateOnConnection, persistCollaborationYDoc } = await import('../app/lib/collaboration/persistence');
    const { authoritativeNativeCollaborationSnapshot } = await import('../app/lib/collaboration/document-snapshot');
    const { inspectPersistedDocumentLinks } = await import('../app/lib/markdown/workspace-native-link-inventory');
    const { readWorkspaceLinkSourceAuthorityOnConnection } = await import('../app/lib/markdown/workspace-source-authority-stage');
    const { WorkspaceOperationJournal, serializeWorkspaceOperationRequest } = await import('../app/lib/files/workspace-operation-journal');
    const { WorkspaceOperationStaging } = await import('../app/lib/files/workspace-operation-staging');
    const { nativeCopyPhaseAdmissions, nativeCopyPhaseReceiptProof } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
    const { captureCollaborationAdmissionRequest } = await import('../app/lib/collaboration/room-admission-contract');
    const { readHistoricalCollaborationAdmissionOutcomeOnConnection } = await import('../app/lib/collaboration/room-admission-outcome');
    const journal = new WorkspaceOperationJournal(), staging = new WorkspaceOperationStaging();
    for (const selected of [source, destination]) await mkdir(selected.rootPath, { recursive: true, mode: 0o700 });
    type Representation = 'plain_text' | 'tiptap_xml' | 'tiptap_blocks';
    type SqlEvent = { text: string; values: unknown[]; client: PoolClient; result: QueryResult;
      raw: (text: string, values?: unknown[]) => Promise<QueryResult> };
    type Job = { operationId: string; origin: WorkspaceOperationCopyOrigin; request?: NextRequest;
      selections: Array<{ sourcePath: string; destinationPath: string }>; expectedPlanId: string; plan: WorkspaceOperationNativeCopyPlan };
    let probe: ((event: SqlEvent) => Promise<void>) | undefined;
    let beforeCommit: ((event: Omit<SqlEvent, 'result'>) => Promise<void>) | undefined;
    const observedClients = new Map<PoolClient, PropertyDescriptor | undefined>();
    const initialBodies = new Map<string, Omit<NativeCopyReceipt, 'publicationStatus'>>();
    const initialStages = new Map<string, WorkspaceOperationNativeCopyStage>();
    const birthWitnesses = new Map<string, { pid: number; xid: string }>();
    const publicationWitnesses = new Map<string, { pid: number; xid: string }>();
    const completionWitnesses = new Map<string, { pid: number; xid: string }>();
    const writeWitnesses: Array<{ pid: number; xid: string; table: string; operationId: string }> = [];
    type TimingBucket = { calls: number; wallMs: number; processUserMicros: number; processSystemMicros: number };
    type TransactionMeasurement = { client: number; sequence: number; startedAt: number; startedUtc: string;
      startedCpu: NodeJS.CpuUsage; startedHrtimeMicros: string;
      backend: number | null; transaction: string | null; operationId: string | null;
      statements: number; productStatements: number; fixtureStatements: number; completedStatements: number;
      failedStatements: number; keywords: Record<string, number>; productQueryAwaitMs: number; fixtureQueryAwaitMs: number;
      stageAcknowledgement: TimingBucket; writeAcknowledgement: TimingBucket };
    type FinishedMeasurement = Omit<TransactionMeasurement, 'startedAt' | 'startedCpu'> & { elapsedMs: number; endedUtc: string;
      endedHrtimeMicros: string; processUserMicros: number; processSystemMicros: number;
      end: 'commit' | 'rollback' | 'sql_error' | 'query_error'; sqlstate: string | null };
    const measuredClients = new Map<PoolClient, number>(), activeMeasurements = new Map<PoolClient, TransactionMeasurement>();
    const finishedMeasurements: FinishedMeasurement[] = [], failedMeasurements: FinishedMeasurement[] = [];
    let measurementSequence = 0;
    const hrtimeMicros = () => (process.hrtime.bigint() / BigInt(1000)).toString();
    const addTiming = (bucket: TimingBucket, startedAt: number, cpu: NodeJS.CpuUsage) => {
      const used = process.cpuUsage(cpu); bucket.calls++; bucket.wallMs += performance.now() - startedAt;
      bucket.processUserMicros += used.user; bucket.processSystemMicros += used.system;
    };
    const finishMeasurement = (client: PoolClient, metric: TransactionMeasurement, end: FinishedMeasurement['end'], sqlstate: string | null = null) => {
      const { startedAt, startedCpu, ...body } = metric, used = process.cpuUsage(startedCpu);
      const measured = { ...body, keywords: { ...body.keywords }, stageAcknowledgement: { ...body.stageAcknowledgement },
        writeAcknowledgement: { ...body.writeAcknowledgement }, elapsedMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
        endedHrtimeMicros: hrtimeMicros(), processUserMicros: used.user, processSystemMicros: used.system,
        endedUtc: new Date().toISOString(), end, sqlstate };
      finishedMeasurements.push(measured); if (finishedMeasurements.length > 64) finishedMeasurements.shift();
      if (end === 'sql_error' || end === 'query_error') { failedMeasurements.push(measured); if (failedMeasurements.length > 8) failedMeasurements.shift(); }
      if (activeMeasurements.get(client) === metric) activeMeasurements.delete(client);
    };
    // Count only actually dispatched SQL, including the unchanged fixture
    // witness reads. JS timing adds no query, sleep or transaction statement.
    const measureQuery = async (client: PoolClient, text: string, origin: 'product' | 'fixture',
      operation: () => Promise<QueryResult>): Promise<QueryResult> => {
      const keyword = /^\s*([a-z]+)/iu.exec(text)?.[1].toUpperCase() ?? 'UNKNOWN';
      let metric = activeMeasurements.get(client);
      if (keyword === 'BEGIN' && !metric) {
        metric = { client: measuredClients.get(client)!, sequence: ++measurementSequence,
          startedAt: performance.now(), startedUtc: new Date().toISOString(), startedCpu: process.cpuUsage(), startedHrtimeMicros: hrtimeMicros(),
          backend: null, transaction: null, operationId: null,
          statements: 0, productStatements: 0, fixtureStatements: 0, completedStatements: 0, failedStatements: 0, keywords: {},
          productQueryAwaitMs: 0, fixtureQueryAwaitMs: 0,
          stageAcknowledgement: { calls: 0, wallMs: 0, processUserMicros: 0, processSystemMicros: 0 },
          writeAcknowledgement: { calls: 0, wallMs: 0, processUserMicros: 0, processSystemMicros: 0 } };
        activeMeasurements.set(client, metric);
      }
      if (metric) {
        metric.statements++; metric[origin === 'product' ? 'productStatements' : 'fixtureStatements']++;
        metric.keywords[keyword] = (metric.keywords[keyword] ?? 0) + 1;
      }
      const queryStartedAt = performance.now(); let recordedAwait = false;
      const recordQueryAwait = () => {
        if (metric && !recordedAwait) {
          metric[origin === 'product' ? 'productQueryAwaitMs' : 'fixtureQueryAwaitMs'] += performance.now() - queryStartedAt;
          recordedAwait = true;
        }
      };
      try {
        const result = await operation();
        recordQueryAwait();
        if (metric) {
          metric.completedStatements++;
          const row = (Array.isArray(result.rows) ? result.rows[0] : undefined) as Record<string, unknown> | undefined;
          const backend = row?.backend ?? row?.pid, transaction = row?.xid ?? row?.transaction;
          if (Number.isSafeInteger(backend)) metric.backend = Number(backend);
          if (typeof transaction === 'string' && /^[0-9]{1,32}$/u.test(transaction)) metric.transaction = transaction;
          if (keyword === 'COMMIT') finishMeasurement(client, metric, 'commit');
          else if (keyword === 'ROLLBACK' && !/^\s*ROLLBACK\s+TO\b/iu.test(text)) finishMeasurement(client, metric, 'rollback');
        }
        return result;
      } catch (error) {
        recordQueryAwait();
        if (metric) {
          metric.failedStatements++;
          const code = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null;
          const sqlstate = typeof code === 'string' && /^[A-Z0-9]{5}$/u.test(code) ? code : null;
          finishMeasurement(client, metric, sqlstate ? 'sql_error' : 'query_error', sqlstate);
        }
        throw error;
      }
    };
    type QueryFacts = { keyword: string; families: string[]; identityWitness: boolean };
    const queryFacts = (text: string): QueryFacts => ({
      keyword: /^\s*([a-z]+)/iu.exec(text)?.[1].toUpperCase() ?? 'UNKNOWN',
      families: [...new Set(text.match(/\b(?:collaboration_[a-z0-9_]+|workspace_file_[a-z0-9_]+|file_collaboration_lineages|canvas_workspaces|pg_stat_activity|pg_locks)\b/giu) ?? [])].slice(0, 8),
      identityWitness: /\bpg_backend_pid\s*\(/iu.test(text) && /\b(?:pg_current_xact_id|pg_current_xact_id_if_assigned)\s*\(/iu.test(text),
    });
    const successfulQueries: QueryFacts[] = [], queryRejections: Array<QueryFacts & { sqlstate: string; table: string | null; constraint: string | null }> = [];
    const identityWitnesses: Array<{ backend: number | null; transaction: string | null; isolation: string | null; readOnly: string | null }> = [];
    const boundedPush = <T>(items: T[], value: T, limit: number) => { items.push(value); if (items.length > limit) items.shift(); };
    const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value) ? value : null;
    const actualPool = runtime as unknown as Pool;
    const onAcquire = (client: PoolClient) => {
      if (observedClients.has(client)) return;
      const prior = Object.getOwnPropertyDescriptor(client, 'query'), original = client.query.bind(client);
      observedClients.set(client, prior);
      measuredClients.set(client, measuredClients.size + 1);
      const raw = (text: string, values?: unknown[]) => measureQuery(client, text, 'fixture', () => original(text, values));
      Object.defineProperty(client, 'query', { configurable: true, writable: true, value: (...args: unknown[]) => {
        // Authentication's ordinary pool.query callback keeps its genuine path.
        // Only actual awaited query ACKs on checked-out B are observed/held.
        if (typeof args.at(-1) === 'function' || typeof args[0] !== 'string') return Reflect.apply(original, client, args);
        const text = args[0], values = Array.isArray(args[1]) ? args[1] : [];
        const actual = (async () => {
          if (/^\s*COMMIT\s*$/iu.test(text)) await beforeCommit?.({ text, values, client, raw });
          return measureQuery(client, text, 'product', () => Reflect.apply(original, client, args) as Promise<QueryResult>);
        })();
        return actual.then(async result => {
          const facts = queryFacts(text); boundedPush(successfulQueries, facts, 48);
          if (facts.identityWitness) {
            const row = result.rows[0] as Record<string, unknown> | undefined;
            if (row) {
              const backend = row.backend ?? row.pid, transaction = row.xid ?? row.transaction;
              boundedPush(identityWitnesses, { backend: Number.isSafeInteger(backend) ? Number(backend) : null,
                transaction: typeof transaction === 'string' && /^[0-9]{1,32}$/u.test(transaction) ? transaction : null,
                isolation: ['read committed', 'repeatable read', 'serializable'].includes(String(row.isolation)) ? String(row.isolation) : null,
                readOnly: ['on', 'off'].includes(String(row.read_only)) ? String(row.read_only) : null }, 32);
            }
          }
          const event = { text, values, client, result, raw };
          if (/^\s*INSERT\s+INTO\s+(?:"?\w+"?\.)?"?collaboration_native_copy_receipts\b/iu.test(text)) {
            const operationId = values.find(value => typeof value === 'string' && value.startsWith('copy-owner-'));
            if (typeof operationId === 'string') {
              const row = (await raw('SELECT private_result FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows[0];
              assert(row); initialBodies.set(operationId, structuredClone(row.private_result));
              const metric = activeMeasurements.get(client), startedAt = performance.now(), cpu = process.cpuUsage();
              try {
                const originalStage = await staging.loadNativeCopyByOperationId(operationId); assert(originalStage);
                assert.equal(originalStage.identity.operationId, operationId); initialStages.set(operationId, originalStage);
              } finally { if (metric) addTiming(metric.stageAcknowledgement, startedAt, cpu); }
              const witness = (await raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
              assert.equal(typeof witness.xid, 'string'); birthWitnesses.set(operationId, witness);
            }
          }
          const table = /^\s*(?:INSERT\s+INTO|UPDATE)\s+(?:"?\w+"?\.)?"?(workspace_file_operations|workspace_file_operation_steps|collaboration_documents|collaboration_yjs_states|file_collaboration_lineages|collaboration_native_copy_receipts|collaboration_native_link_mutation_receipts)\b/iu.exec(text)?.[1];
          if (table) {
            const measured = activeMeasurements.get(client), startedAt = performance.now(), cpu = process.cpuUsage();
            try {
              const witness = (await raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
              assert(witness && typeof witness.xid === 'string');
              const operationId = values.find(value => typeof value === 'string' && value.startsWith('copy-owner-'));
              writeWitnesses.push({ pid: witness.pid, xid: witness.xid, table, operationId: typeof operationId === 'string' ? operationId : '' });
              const metric = activeMeasurements.get(client);
              if (metric && typeof operationId === 'string') metric.operationId = operationId;
              if (typeof operationId === 'string') {
                if (table === 'collaboration_native_copy_receipts' && /^\s*UPDATE\b/iu.test(text)
                  && /\bpublication_status\s*=\s*'published'/iu.test(text)) publicationWitnesses.set(operationId, witness);
                if (table === 'workspace_file_operations' && /^\s*UPDATE\b/iu.test(text)
                  && /\bstatus\s*=\s*'completed'/iu.test(text)) completionWitnesses.set(operationId, witness);
              }
            } finally { if (measured) addTiming(measured.writeAcknowledgement, startedAt, cpu); }
          }
          await probe?.(event); return result;
        }, error => {
          const sqlstate = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
          if (typeof sqlstate === 'string' && /^[A-Z0-9]{5}$/u.test(sqlstate)) boundedPush(queryRejections,
            { ...queryFacts(text), sqlstate, table: identifier(Object.getOwnPropertyDescriptor(error, 'table')?.value),
              constraint: identifier(Object.getOwnPropertyDescriptor(error, 'constraint')?.value) }, 16);
          throw error;
        });
      } });
    };
    actualPool.on('acquire', onAcquire);
    restorers.push(() => {
      actualPool.removeListener('acquire', onAcquire);
      for (const [client, prior] of observedClients) {
        if (prior) Object.defineProperty(client, 'query', prior); else Reflect.deleteProperty(client, 'query');
      }
    });
    const fstatDescriptor = Object.getOwnPropertyDescriptor(io, 'fstatSync'); assert(fstatDescriptor);
    Object.defineProperty(io, 'fstatSync', { ...fstatDescriptor, value: (...args: unknown[]) => {
      const info = Reflect.apply(actualFstat, io, args) as Stats | BigIntStats;
      if (info.isFile() || info.isDirectory()) observedNodes.add(`${info.dev}:${info.ino}`); return info;
    } });
    restorers.push(() => { Object.defineProperty(io, 'fstatSync', fstatDescriptor); });
    const assertClosedFds = () => {
      const directory = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd', remaining: number[] = [];
      for (const name of io.readdirSync(directory)) {
        if (!/^\d+$/u.test(name)) continue;
        try { if (observedNodes.has(nodeKey(actualFstat(Number(name), { bigint: true })))) remaining.push(Number(name)); }
        catch (error) { if (Reflect.get(error as object, 'code') !== 'EBADF') throw error; }
      }
      assert.deepEqual(remaining, [], 'Every actual source, stage and published-target FD closes after the fixed Owner returns.');
    };
    const originalCheck = check;
    const group = async (name: string, operation: () => Promise<void>) => originalCheck(name, async () => {
      assert.equal(probe, undefined); await operation(); assert.equal(probe, undefined); assertClosedFds();
      assert.equal(await staging.readKind(`absent-${crypto.randomUUID()}`), null);
    });
    const withProbe = async <T>(observe: (event: SqlEvent) => Promise<void>, operation: () => Promise<T>): Promise<T> => {
      assert.equal(probe, undefined); probe = observe;
      try { return await operation(); } finally { probe = undefined; }
    };
    const put = async (selected: WorkspaceContext, filename: string, content: string | Buffer) => {
      const target = path.join(selected.rootPath, filename); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o600 }); return target;
    };
    const missing = async (filename: string) => {
      await assert.rejects(lstat(filename), (error: unknown) => error instanceof Error && Reflect.get(error, 'code') === 'ENOENT');
    };
    const seedNative = async (selected: WorkspaceContext, filename: string, representation: Representation, text: string,
      options: { richTable?: boolean; projection?: boolean } = {}) => {
      const documentId = `copy-source-${crypto.randomUUID()}`, lineageId = `copy-lineage-${crypto.randomUUID()}`;
      const document = options.richTable && representation !== 'plain_text'
        ? nativeRichDocumentFixture({ type: 'doc', content: [{ type: 'table', content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', attrs: { colwidth: [120] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Width' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', attrs: { colwidth: [120] }, content: [{ type: 'paragraph', content: [
            { type: 'text', text: 'Independent 😀', marks: [{ type: 'link', attrs: { href: `/${path.posix.dirname(filename)}/target.md#Heading` } }] },
            { type: 'text', text: ' Relative target', marks: [{ type: 'link', attrs: { href: 'target.md#Heading' } }] },
          ] }] }] },
        ] }] }, representation)
        : representation === 'plain_text' ? createPlainTextYDoc(text) : createRichMarkdownYDoc(text, representation);
      try {
        if (representation !== 'plain_text') {
          document.getText('frontmatter').insert(0, '---\r\ntitle: Exact native copy\r\n---\r\n');
          document.getText('bodyFinalLineEnding').insert(0, '\r\n\r\n');
        }
        const state: PersistedCollaborationState = { documentId, workspaceId: selected.workspaceId,
          organizationId: selected.organizationId ?? null, path: filename, representation, lifecycleGeneration: 1, schemaVersion: 1,
          documentSequence: 7, persistedAt: 100, checkpointSequence: 0, checkpointedAt: null, canonicalHash: null, serializedHash: null,
          newlineStyle: 'crlf', hasBom: true, degraded: false, status: 'active',
          yjsState: Buffer.from(Y.encodeStateAsUpdate(document)), stateVector: Buffer.from(Y.encodeStateVector(document)) };
        authoritativeNativeCollaborationSnapshot(state);
        await admin.query(`INSERT INTO file_collaboration_lineages(id,workspace_id,workspace_type,organization_id,path,status,created_at)
          VALUES($1,$2,$3,$4,$5,'active',100)`, [lineageId, selected.workspaceId, selected.workspaceType, selected.organizationId, filename]);
        await admin.query(`INSERT INTO collaboration_documents(id,lineage_id,workspace_id,workspace_type,organization_id,path,provider,
          state_version,yjs_state_lifecycle,status,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'yjs',7,'initialized','active',100,100)`,
        [documentId, lineageId, selected.workspaceId, selected.workspaceType, selected.organizationId, filename]);
        await admin.query(`INSERT INTO collaboration_yjs_states(document_id,workspace_id,organization_id,path,representation,lifecycle_generation,
          schema_version,yjs_state,state_vector,document_sequence,persisted_at,checkpoint_sequence,newline_style,has_bom,degraded,status)
          VALUES($1,$2,$3,$4,$5,1,1,$6,$7,7,100,0,'crlf',1,0,'active')`,
        [documentId, selected.workspaceId, selected.organizationId, filename, representation, state.yjsState, state.stateVector]);
        await admin.query('INSERT INTO collaboration_file_projections(document_id,lifecycle_generation,projected_sequence,finalized,updated_at) VALUES($1,1,0,0,100)', [documentId]);
        if (options.projection) await put(selected, filename, 'STALE native projection MUST NOT be copied\n');
        const rows = await admin.query('SELECT row_to_json(s)::text AS body FROM collaboration_yjs_states s WHERE document_id=$1', [documentId]);
        existingSources.set(documentId, rows.rows[0].body);
        return { state, lineageId };
      } finally { document.destroy(); }
    };
    const load = async (documentId: string) => {
      const value = await loadCollaborationStateOnConnection(rawConnection(admin), documentId); assert(value); return value;
    };
    const prepareJob = async (selected: { sourcePath: string; destinationPath: string }[], a = destination, b = a,
      options: { cookie?: boolean; origin?: WorkspaceOperationCopyOrigin; agent?: boolean; renameOnCollision?: boolean } = {}): Promise<Job> => {
      const origin = options.origin ?? memberOrigin(a, b), actualRequest = options.agent ? undefined : await request(options.cookie);
      if (actualRequest) {
        const session = await auth.api.getSession({ headers: actualRequest.headers }); assert(session);
        assert.equal(session.user.id, origin.actor.userId); assert.equal(session.session.id, origin.actor.sessionId);
      }
      // Diagnostic reads use only this fixture's real private-schema rows and
      // current physical paths. These pure planning observations grant no
      // principal, session owner or mutation authority to the actual runner.
      const sourceObservation = await readWorkspaceLinkSourceAuthorityOnConnection(rawConnection(admin), a);
      const destinationObservation = a.workspaceId === b.workspaceId ? sourceObservation
        : await readWorkspaceLinkSourceAuthorityOnConnection(rawConnection(admin), b);
      const facts = (observation: typeof sourceObservation) => ({ workspaceId: observation.stage.workspaceId,
        readiness: observation.stage.readiness, coverage: { complete: observation.stage.coverage.complete,
          gapCount: observation.stage.coverage.gaps.length,
          gaps: observation.stage.coverage.gaps.slice(0, 32).map(value => ({ code: value.code, path: value.path })) },
        namespaceCount: observation.stage.namespace.length, namespace: observation.stage.namespace.slice(0, 48).map(value => ({
          path: value.path, kind: value.kind, identity: value.identity, documentId: value.documentId,
          lifecycleGeneration: value.lifecycleGeneration, physical: value.filesystemIdentity !== null })),
        sourceCount: observation.stage.sources.length, sources: observation.stage.sources.slice(0, 48).map(value => ({ kind: value.kind,
          path: value.kind === 'native' ? value.inventory.document.path : value.inventory.path,
          authority: value.kind === 'native' ? 'persisted-native' : value.inventory.authority.kind,
          coverage: value.inventory.coverage.complete, gapCount: value.inventory.coverage.gaps.length })) });
      const diagnostic: Record<string, unknown> = { diagnostic: 'native-copy-owner-before-preview',
        source: facts(sourceObservation), destination: facts(destinationObservation), selections: selected };
      const { createWorkspaceOperationNativeCopyPlan } = await import('../app/lib/files/workspace-operation-native-copy-plan');
      let isolatedPlan: WorkspaceOperationNativeCopyPlan | undefined;
      try {
        isolatedPlan = createWorkspaceOperationNativeCopyPlan({ sourceScope: { workspace: a, fileOptions: { workspace: a } },
          destinationScope: { workspace: b, fileOptions: { workspace: b } }, selections: selected, sourceObservation, destinationObservation });
        diagnostic.isolatedC1 = { planId: isolatedPlan.planId, readiness: isolatedPlan.readiness, cloneCount: isolatedPlan.cloneRequirements.length };
      } catch (error) { diagnostic.isolatedC1 = { name: error instanceof Error ? error.name : 'NonError',
        code: error instanceof Error ? Reflect.get(error, 'code') ?? null : null }; }
      try {
        const { workspaceOperationNativePlanSnapshot } = await import('../app/lib/files/workspace-operation-native-plan-data');
        const { createWorkspaceNativeFileOperationPlan } = await import('../app/lib/markdown/workspace-native-file-operation-planner');
        const { compileWorkspaceNativeMixedBatch } = await import('../app/lib/markdown/workspace-native-mixed-batch-compiler');
        const snapshots = (sourceObservation === destinationObservation ? [sourceObservation] : [sourceObservation, destinationObservation])
          .map(value => workspaceOperationNativePlanSnapshot(value, () => { throw new Error('Actual source observation cannot form a complete native snapshot.'); }));
        const request = { kind: 'copy' as const, sourceWorkspaceId: a.workspaceId, destinationWorkspaceId: b.workspaceId, selections: selected };
        const pathPlan = createWorkspaceNativeFileOperationPlan({ ...request, snapshots });
        const compiled = compileWorkspaceNativeMixedBatch({ snapshots, states: sourceObservation === destinationObservation
          ? sourceObservation.privateNativeStates : [...sourceObservation.privateNativeStates, ...destinationObservation.privateNativeStates], requests: [request] });
        diagnostic.pathPlan = { readiness: pathPlan.readiness, issueCount: pathPlan.issues.length,
          issues: pathPlan.issues.slice(0, 32).map(value => ({ code: value.code, path: value.path })) };
        diagnostic.compiler = { readiness: compiled.readiness, issueCount: compiled.issues.length,
          issues: compiled.issues.slice(0, 32).map(value => ({ code: value.code, path: value.path })) };
      } catch (error) { diagnostic.graphDiagnostic = { name: error instanceof Error ? error.name : 'NonError' }; }
      if (!isolatedPlan) try {
        const { captureWorkspaceOperationJobScope } = await import('../app/lib/files/workspace-operation-job-scope');
        // Finite private source data for a later pure reproduction, deliberately
        // excluding request headers, cookies, tokens, sessions and principals.
        const bytes = serialize({ sourceScope: { workspace: { ...captureWorkspaceOperationJobScope(a), permissions: { ...a.permissions } }, fileOptions: {} },
          destinationScope: { workspace: { ...captureWorkspaceOperationJobScope(b), permissions: { ...b.permissions } }, fileOptions: {} },
          selections: selected, sourceObservation, destinationObservation });
        assert(bytes.byteLength <= 64 * 1024 * 1024, 'Private diagnostic reproduction is bounded to 64 MiB.');
        const filename = path.join(tmpdir(), `native-copy-preview-${crypto.randomUUID()}.bin`);
        await writeFile(filename, bytes, { flag: 'wx', mode: 0o600 });
        diagnostic.reproduction = { path: filename, format: 'node-v8-private-source-data', sizeBytes: bytes.byteLength,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
      } catch (error) { diagnostic.reproductionError = { name: error instanceof Error ? error.name : 'NonError' }; }
      console.log(JSON.stringify(diagnostic));
      const plan = await preview({ origin, ...(actualRequest ? { request: actualRequest } : {}), selections: selected,
        ...(options.renameOnCollision ? { renameOnCollision: true } : {}) });
      if (isolatedPlan && !options.renameOnCollision) assert.equal(plan.planId, isolatedPlan.planId, 'The genuine owner preview agrees with the independently read original C1 plan.');
      assert.equal(plan.kind, 'native-copy'); assert.equal(plan.executionReady, false);
      assert.equal(plan.sourceScope.workspaceId, a.workspaceId); assert.equal(plan.destinationScope.workspaceId, b.workspaceId);
      return { operationId: `copy-owner-${crypto.randomUUID()}`, origin, request: actualRequest,
        selections: plan.selections.map(value => ({ ...value })), expectedPlanId: plan.planId, plan };
    };
    const run = (job: Job) => execute({ operationId: job.operationId, origin: job.origin,
      ...(job.request ? { request: job.request } : {}), selections: job.selections, expectedPlanId: job.expectedPlanId });
    const ledger = async (operationId: string) => {
      const row = (await admin.query('SELECT *,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [operationId])).rows;
      assert.equal(row.length, 1); return row[0] as Record<string, unknown> & { private_result: Omit<NativeCopyReceipt, 'publicationStatus'> };
    };
    const stateCounts = async (operationId: string) => (await admin.query(`SELECT
      (SELECT count(*) FROM workspace_file_operations WHERE operation_id=$1)::integer AS operations,
      (SELECT count(*) FROM workspace_file_operation_steps WHERE operation_id=$1)::integer AS steps,
      (SELECT count(*) FROM collaboration_native_copy_receipts WHERE operation_id=$1)::integer AS receipts`, [operationId])).rows[0];
    const assertComplete = async (job: Job, result: Awaited<ReturnType<typeof run>>) => {
      if (result.execution.status !== 'complete') {
        // Only bounded current facts from this private fixture, captured before
        // its normal finally removes rows. Never log query text, parameters,
        // native content, credentials or the private receipt body.
        try {
          const header = (await admin.query(`SELECT status,revision,expected_step_count,error_code FROM workspace_file_operations
            WHERE operation_id=$1`, [job.operationId])).rows;
          const steps = (await admin.query(`SELECT step_key,phase,status FROM workspace_file_operation_steps
            WHERE operation_id=$1 ORDER BY step_key LIMIT 65`, [job.operationId])).rows;
          const receipts = (await admin.query(`SELECT version,publication_status,
            jsonb_array_length(private_result->'documents') AS documents FROM collaboration_native_copy_receipts
            WHERE operation_id=$1 LIMIT 2`, [job.operationId])).rows;
          console.log(JSON.stringify({ diagnostic: 'native-copy-owner-before-complete',
            execution: { status: result.execution.status, errorCode: result.execution.errorCode,
              completedSteps: result.execution.completedSteps.slice(0, 65), pendingSteps: result.execution.pendingSteps.slice(0, 65) },
            header, steps, receipts, successfulQueries, queryRejections, identityWitnesses,
            actualWriteWitnesses: writeWitnesses.slice(-32), transactionCountUnit: 'actual-query-dispatch', timingBucketsOverlap: true,
            finishedTransactions: finishedMeasurements, failedTransactions: failedMeasurements }));
        } catch (error) {
          console.log(JSON.stringify({ diagnostic: 'native-copy-owner-before-complete-unavailable', name: error instanceof Error ? error.name : 'NonError' }));
        }
      }
      assert.equal(result.execution.status, 'complete'); assert.equal(result.execution.operationId, job.operationId);
      assert.deepEqual(result.copied, job.selections.map(value => value.destinationPath));
      const operation = await journal.get(job.operationId); assert(operation); assert.equal(operation.status, 'completed');
      const serialized = serializeWorkspaceOperationRequest({ kind: 'copy', selections: job.selections, origin: job.origin });
      assert.equal(operation.requestJson, serialized.requestJson); assert.equal(operation.requestHash, serialized.requestHash);
      assert.equal(operation.expectedStepCount, operation.steps.length); assert(operation.steps.every(value => value.status === 'applied'));
      const row = await ledger(job.operationId); assert.equal(row.publication_status, 'published');
      assert.equal(row.actor_user_id, job.origin.actor.userId); assert.equal(row.actor_session_id, job.origin.actor.sessionId);
      assert.deepEqual(row.private_result, initialBodies.get(job.operationId), 'Initial C3 body stays immutable after link deltas and publication.');
      assert.equal(row.private_result.documents.length, job.plan.cloneRequirements.length);
      const publication = publicationWitnesses.get(job.operationId), completion = completionWitnesses.get(job.operationId);
      assert(publication, 'The actual B2 publication-status UPDATE must have executed.');
      assert(completion, 'The actual completed-header UPDATE must have executed.');
      assert.deepEqual(publication, completion, 'Publication and Journal completion execute on the same actual B2 backend/XID.');
      const completionXmin = (BigInt(publication.xid) % BigInt('4294967296')).toString();
      assert.equal(row.xmin, completionXmin);
      const completedRows = (await admin.query(`SELECT xmin::text AS xmin FROM workspace_file_operations WHERE operation_id=$1
        UNION ALL SELECT xmin::text FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='copy-completion'`, [job.operationId])).rows;
      assert.equal(completedRows.length, 2); assert(completedRows.every(value => value.xmin === completionXmin));
      const originalStage = initialStages.get(job.operationId), initialBody = initialBodies.get(job.operationId);
      assert(originalStage); assert(initialBody);
      assert.equal(originalStage.identity.canonicalRequestHash, serialized.requestHash);
      assert.equal(originalStage.plan.planId, job.expectedPlanId);
      const originalReceipt: NativeCopyReceipt = { ...initialBody, publicationStatus: 'native_committed' };
      const admissions = nativeCopyPhaseAdmissions(originalStage, originalReceipt);
      assert(admissions.length > 0, 'Every actual original selection belongs to an exact publication admission.');
      // Exact original Stage/receipt data is retained only as fixture evidence.
      // It grants neither a current principal nor a reservation-skip capability.
      await admin.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const allHeaders = (await admin.query(`SELECT request_id,intent_text FROM collaboration_admission_requests LIMIT 1001`)).rows;
        assert(allHeaders.length < 1001, 'The bounded fixture must not hide an additional original admission.');
        const actualRequests = allHeaders.filter(value => {
          const intent = JSON.parse(value.intent_text);
          if (intent.action !== 'copy_replace') return false;
          let payload: Record<string, unknown>;
          try { payload = JSON.parse(intent.actionPayloadText); } catch { return false; }
          return payload.kind === 'native-copy-publication' && payload.operationId === job.operationId;
        }).map(value => value.request_id).sort();
        assert.deepEqual(actualRequests, admissions.map(value => value.requestId).sort(), 'The completed admission set exactly matches the original batch.');
        for (const admission of admissions) {
          const captured = captureCollaborationAdmissionRequest(admission);
          const headers = (await admin.query(`SELECT request_digest,intent_text,status,completed_at,outcome_text,xmin::text AS xmin
            FROM collaboration_admission_requests WHERE request_id=$1`, [admission.requestId])).rows;
          assert.equal(headers.length, 1); const header = headers[0];
          assert.equal(header.request_digest, captured.requestDigest); assert.equal(header.intent_text, captured.intentText);
          assert.equal(header.status, 'committed'); assert.equal(header.xmin, completionXmin);
          assert(Number.isSafeInteger(Number(header.completed_at)) && Number(header.completed_at) > 0);
          assert.equal(typeof header.outcome_text, 'string');
          const scopes = (await admin.query(`SELECT workspace_id,organization_id,path,kind FROM collaboration_admission_scopes
            WHERE request_id=$1 ORDER BY ordinal`, [admission.requestId])).rows;
          assert.deepEqual(scopes.map(value => ({ workspaceId: value.workspace_id, organizationId: value.organization_id,
            path: value.path, kind: value.kind })), admission.scopes);
          const targets = (await admin.query(`SELECT document_id,status,active,outcome_snapshot_text,outcome_snapshot_digest,xmin::text AS xmin
            FROM collaboration_admission_targets WHERE request_id=$1 ORDER BY document_id`, [admission.requestId])).rows;
          assert.deepEqual(targets.map(value => value.document_id), admission.expectedDocuments.map(value => value.documentId));
          for (const target of targets) {
            assert.equal(target.status, 'completed'); assert.equal(target.active, false); assert.equal(target.xmin, completionXmin);
            assert.equal(typeof target.outcome_snapshot_text, 'string'); assert.match(target.outcome_snapshot_digest, /^[a-f0-9]{64}$/u);
          }
          const outcome = await readHistoricalCollaborationAdmissionOutcomeOnConnection(rawConnection(admin), captured, { readOnly: true });
          assert(outcome); assert.equal(outcome.version, 1); assert.equal(outcome.requestId, admission.requestId);
          assert.equal(outcome.requestDigest, captured.requestDigest); assert.equal(JSON.stringify(outcome), header.outcome_text);
          assert.deepEqual({ ...outcome.result }, { kind: 'native-copy-publication', operationId: job.operationId,
            stageDigest: originalStage.payloadSha256, copyReceiptProof: nativeCopyPhaseReceiptProof(originalReceipt), finalGraphProof: originalStage.plan.finalGraphProof });
          assert.deepEqual(outcome.targets.map(value => value.documentId), admission.expectedDocuments.map(value => value.documentId));
        }
        assert.equal((await admin.query('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, null);
        await admin.query('COMMIT');
      } catch (error) { await admin.query('ROLLBACK'); throw error; }
      const birth = birthWitnesses.get(job.operationId); assert(birth);
      if (row.private_result.documents.length) {
        const ids = row.private_result.documents.map(value => value.clone.documentId), lineageIds = row.private_result.documents.map(value => value.clone.lineageId);
        const writes = (await admin.query(`SELECT xmin::text AS xmin FROM collaboration_documents WHERE id=ANY($1::text[])
          UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=ANY($1::text[])
          UNION ALL SELECT xmin::text FROM file_collaboration_lineages WHERE id=ANY($2::text[])
          UNION ALL SELECT xmin::text FROM collaboration_native_link_mutation_receipts WHERE document_id=ANY($1::text[])`, [ids, lineageIds])).rows;
        const mutations = new Set(job.plan.nativePathPlan.mutations.filter(value => {
          const previous = value.reference.kind === 'link-mark' ? value.reference.expected.href : value.reference.expected;
          assert.equal(typeof previous, 'string'); assert.equal(value.action, 'rewrite'); assert.equal(typeof value.nextValue, 'string');
          return previous !== value.nextValue;
        }).map(value => value.sourcePathAfter)).size;
        assert.equal(writes.length, ids.length * 3 + mutations);
        assert(writes.every(value => value.xmin === (BigInt(birth.xid) % BigInt('4294967296')).toString()),
          'Every successful clone birth and link delta belongs to the actual initial receipt B1 backend/XID.');
      }
      for (const clone of row.private_result.documents) {
        const original = await load(clone.source.documentId), actual = await load(clone.clone.documentId);
        assert.notEqual(actual.documentId, original.documentId); assert.notEqual(clone.clone.lineageId,
          (await admin.query('SELECT lineage_id FROM collaboration_documents WHERE id=$1', [original.documentId])).rows[0].lineage_id);
        assert.equal(actual.workspaceId, job.origin.destinationScope.workspaceId); assert.equal(actual.path, clone.clone.path);
        assert.equal(actual.lifecycleGeneration, 1); assert.equal(actual.representation, original.representation);
        assert.equal(actual.newlineStyle, original.newlineStyle); assert.equal(actual.hasBom, original.hasBom);
        const recipes = job.plan.nativePathPlan.mutations.filter(value => value.source.documentId === original.documentId && value.sourcePathAfter === actual.path);
        const effectiveRecipes = recipes.filter(value => {
          const previous = value.reference.kind === 'link-mark' ? value.reference.expected.href : value.reference.expected;
          assert.equal(typeof previous, 'string'); assert.equal(value.action, 'rewrite'); assert.equal(typeof value.nextValue, 'string');
          return previous !== value.nextValue;
        });
        assert.equal(actual.documentSequence, effectiveRecipes.length ? 1 : 0);
        const confirmations = (await admin.query('SELECT count(*)::integer AS n FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [actual.documentId])).rows[0].n;
        assert.equal(confirmations, effectiveRecipes.length ? 1 : 0, 'Equal-spelling/no-link clones retain sequence zero and have no invented mutation receipt.');
        const inventory = inspectPersistedDocumentLinks(actual), originalInventory = inspectPersistedDocumentLinks(original);
        assert.equal(inventory.coverage.complete, true);
        for (const recipe of recipes) assert(inventory.links.some(value => String(value.ref.kind === 'link-mark' ? value.ref.expected.href : value.ref.expected) === recipe.nextValue), 'Actual native clone contains the original planned link literal.');
        const literal = (value: typeof inventory.links[number]) => String(value.ref.kind === 'link-mark' ? value.ref.expected.href : value.ref.expected);
        assert.deepEqual(inventory.links.map(literal), originalInventory.links.map(value =>
          recipes.find(recipe => recipe.linkId === value.id)?.nextValue ?? literal(value)), 'All local, external and unchanged native link targets retain their original ordered membership.');
        const content = authoritativeNativeCollaborationSnapshot(actual).content, beforeContent = authoritativeNativeCollaborationSnapshot(original).content;
        if (content.kind === 'plain_text' && beforeContent.kind === 'plain_text') {
          let expected = beforeContent.text;
          const replacements = effectiveRecipes.map(recipe => {
            assert.equal(recipe.reference.kind, 'plain-target');
            if (recipe.reference.kind !== 'plain-target') assert.fail('Plain fixture must have genuine plain-target spans.');
            return { start: recipe.reference.targetStart, end: recipe.reference.targetEnd, next: recipe.nextValue! };
          }).sort((left, right) => right.start - left.start);
          for (const replacement of replacements) expected = expected.slice(0, replacement.start) + replacement.next + expected.slice(replacement.end);
          assert.equal(content.text, expected, 'Only the planned exact link target ranges change in literal plain text.');
        }
        if (content.kind === 'rich_text' && beforeContent.kind === 'rich_text') {
          assert.equal(content.frontmatter, beforeContent.frontmatter); assert.equal(content.bodyFinalLineEnding, beforeContent.bodyFinalLineEnding);
          const reversed = new Map(Object.entries(clone.blockIdMapping).map(([old, fresh]) => [fresh, old]));
          const normalize = (root: JSONContent, reverse: boolean): JSONContent => {
            const node = structuredClone(root);
            if (node.attrs?.id && reverse) { const originalId = reversed.get(node.attrs.id); assert(originalId); node.attrs.id = originalId; }
            if (node.type === 'obsidianWikiLink' && node.attrs) node.attrs.target = '[separately-checked-target]';
            if (node.type === 'image' && node.attrs) node.attrs.src = '[separately-checked-target]';
            for (const mark of node.marks ?? []) if (mark.type === 'link' && mark.attrs) mark.attrs.href = '[separately-checked-target]';
            if (node.content) node.content = node.content.map(child => normalize(child, reverse)); return node;
          };
          assert.deepEqual(normalize(content.document, true), normalize(beforeContent.document, false), 'Every rich node, text, mark and non-target attribute survives after reversing only genuine fresh semantic IDs.');
        }
        if (original.representation !== 'plain_text') {
          assert.match(JSON.stringify(content), /Exact native copy/u);
          assert.equal(new Set(Object.values(clone.blockIdMapping)).size, Object.keys(clone.blockIdMapping).length);
          assert(Object.keys(clone.blockIdMapping).every(key => key !== clone.blockIdMapping[key]));
          if (JSON.stringify(authoritativeNativeCollaborationSnapshot(original).content).includes('colwidth')) assert.match(JSON.stringify(content), /"colwidth":\[120\]/u);
        }
        assert.equal((await admin.query('SELECT row_to_json(s)::text AS body FROM collaboration_yjs_states s WHERE document_id=$1', [original.documentId])).rows[0].body,
          existingSources.get(original.documentId), 'Copy never changes original native bytes or metadata.');
        assert.equal((await admin.query('SELECT id FROM collaboration_documents WHERE id=$1', [actual.documentId])).rows[0].id, actual.documentId);
        await missing(path.join(job.origin.destinationScope.rootPath, actual.path));
      }
      // Anchor the final graph to the real collector/registry identities, rather
      // than a declared pure fixture namespace or a rehashed result DTO.
      const currentDestination = await workspace(job.origin.destinationScope.workspaceId);
      const observed = await readWorkspaceLinkSourceAuthorityOnConnection(rawConnection(admin), currentDestination);
      assert.equal(observed.stage.coverage.complete, true);
      for (const clone of row.private_result.documents) {
        const entry = observed.stage.namespace.find(value => value.path === clone.clone.path); assert(entry);
        assert.equal(entry.documentId, clone.clone.documentId); assert.equal(entry.identity, `registry:${clone.clone.documentId}:1`);
      }
      assert.equal(await staging.readKind(job.operationId), null, 'Completed stages retire only after real SQL completion.');
      return row.private_result;
    };
    const nativeStage = async (job: Job): Promise<WorkspaceOperationNativeCopyStage> => {
      const manifest = JSON.parse(await readFile(path.join(dataRoot, 'workspace-operation-staging', job.operationId, 'manifest.json'), 'utf8'));
      assert.equal(manifest.version, 2); assert.equal(manifest.kind, 'native-copy');
      assert.equal(manifest.identity.operationId, job.operationId);
      const value = await staging.loadNativeCopy(manifest.identity);
      assert.equal(value.identity.canonicalRequestHash, serializeWorkspaceOperationRequest(value.request).requestHash);
      assert.deepEqual(value.origin, job.origin); return value;
    };
    const renewSession = async () => {
      const id = `renewed-${crypto.randomUUID()}`, token = crypto.randomBytes(32).toString('hex'), time = Date.now();
      await admin.query('INSERT INTO "session"(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,\'member\',$3,$4,$4)',
        [id, token, time + 3600000, time]); tokens.set('member', token); currentMemberSessionId = id; return id;
    };
    const errorHas = (error: unknown, expected: Error | string): boolean => {
      const seen = new Set<unknown>();
      const visit = (value: unknown): boolean => {
        if (!(value instanceof Error) || seen.has(value)) return false; seen.add(value);
        return value === expected || typeof expected === 'string' && Reflect.get(value, 'code') === expected
          || visit(value.cause) || value instanceof AggregateError && value.errors.some(visit);
      }; return visit(error);
    };
    // A fixed service may report a durable recovery result or throw before it
    // can record that result. Neither path may silently report completion.
    const interrupted = async (job: Job, expected: Error | string) => {
      try {
        const value = await run(job);
        if (expected instanceof Error) console.log(JSON.stringify({ diagnostic: 'native-copy-owner-interrupted-expected-error',
          execution: { status: value.execution.status, errorCode: value.execution.errorCode,
            completedSteps: value.execution.completedSteps.slice(0, 65), pendingSteps: value.execution.pendingSteps.slice(0, 65) },
          finishedTransactions: finishedMeasurements, failedTransactions: failedMeasurements, queryRejections,
          actualWriteWitnesses: writeWitnesses.slice(-32), transactionCountUnit: 'actual-query-dispatch', timingBucketsOverlap: true }));
        assert.equal(value.execution.status, 'needs_recovery');
        assert.deepEqual(value.copied, [], 'An unconfirmed operation never invents publicly completed physical paths.');
        assert(value.execution.errorCode, 'Interrupted publication must report a concrete recovery error.');
        if (typeof expected === 'string') assert.equal(value.execution.errorCode, expected);
      } catch (error) {
        if (error instanceof assert.AssertionError) throw error;
        assert(errorHas(error, expected), `Fixed Copy failure must retain the actual expected cause (${typeof expected === 'string' ? expected : expected.name}).`);
      }
      const durable = await journal.get(job.operationId); assert(durable);
      assert.equal(durable.status, 'recovery_required', 'The real journal exposes recovery to existing status/polling consumers.');
      assert.equal(durable.operationId, job.operationId); assert.equal(durable.planId, job.expectedPlanId);
    };
    const folder = async (selected: WorkspaceContext, representation: Representation,
      options: { mixed?: boolean; projection?: boolean; table?: boolean; prefix?: string } = {}) => {
      const root = options.prefix ?? `folder-${crypto.randomUUID()}`;
      const target = await seedNative(selected, `${root}/target.md`, representation, '# Heading\n\nIndependent target 😀');
      const note = await seedNative(selected, `${root}/note.md`, representation,
        `[Absolute](/${root}/target.md#Heading) [Relative](target.md#Heading) [[/${root}/target#Heading|Alias]] [Web](https://example.test)\n\nIndependent 😀`,
        { richTable: options.table, projection: options.projection });
      const empty = await seedNative(selected, `${root}/empty.md`, representation, '');
      if (options.mixed) {
        await put(selected, `${root}/assets/report.pdf`, Buffer.from('%PDF-1.4\nopaque copy asset\n%%EOF\n'));
        await put(selected, `${root}/assets/pixel.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 13, 10, 0xff]));
        await mkdir(path.join(selected.rootPath, root, 'empty-directory'), { recursive: true, mode: 0o700 });
      }
      return { root, target, note, empty };
    };
    await group('actual raw workspace DAL requires original starter initialization before native Copy and cannot silently import physical Markdown', async () => {
      const selected = await workspace(destination.workspaceId, 'owner'), actual = await request(false, 'owner', selected);
      const origin = captureWorkspaceOperationCopyOrigin({ actor: { type: 'user', userId: 'owner', actorId: 'owner', sessionId: 'session-owner' },
        sourceWorkspace: selected, destinationWorkspace: selected });
      const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
      const bytes = await readFile(path.join(selected.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME));
      const initial = await readWorkspaceLinkSourceAuthorityOnConnection(rawConnection(admin), selected);
      assert.equal(initial.stage.readiness, 'requires-import-and-rebinding'); assert.equal(initial.stage.coverage.complete, true);
      const starter = initial.stage.sources.find(value => value.kind === 'physical' && value.inventory.path === WORKSPACE_STARTER_DOCUMENT_NAME);
      assert(starter && starter.kind === 'physical'); assert.equal(starter.inventory.authority.kind, 'unregistered');
      const privateStageRoot = path.join(dataRoot, 'workspace-operation-staging'), stagesBefore = io.existsSync(privateStageRoot) ? await readdir(privateStageRoot) : null;
      const writesBefore = writeWitnesses.length;
      await assert.rejects(preview({ origin, request: actual,
        selections: [{ sourcePath: WORKSPACE_STARTER_DOCUMENT_NAME, destinationPath: 'copied-starter.md' }] }),
      error => error instanceof Error && Reflect.get(error, 'code') === 'NATIVE_COPY_PLAN_UNSUPPORTED');
      assert.equal(writeWitnesses.length, writesBefore, 'Preview rejection performs no clone, link, Journal or physical staging mutation.');
      assert.deepEqual(io.existsSync(privateStageRoot) ? await readdir(privateStageRoot) : null, stagesBefore);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_native_copy_receipts')).rows[0].n, 0);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_native_link_mutation_receipts')).rows[0].n, 0);
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=ANY($1::text[])', [[source.workspaceId, destination.workspaceId]])).rows[0].n, 0);
      assert.deepEqual(await readFile(path.join(selected.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME)), bytes);
    });
    // Match app/api/workspaces/route.ts: raw creation has committed, then the
    // actual API initializer uses the original creating Owner's real request.
    // The explicit test flag was installed BEFORE raw workspace creation; no
    // production gate, starter bytes, principal or receipt is mocked here.
    stage = 'actual workspace API starter initialization';
    const { initializeCreatedWorkspaceStarter } = await import('../app/lib/workspaces/starter-document-initialization-api');
    const { readWorkspaceStarterInitializationIntent } = await import('../app/lib/workspaces/starter-document-initialization-store');
    const { WORKSPACE_STARTER_DOCUMENT_NAME } = await import('../app/lib/workspaces/starter-document');
    for (const id of [source.workspaceId, destination.workspaceId]) {
      const selected = await workspace(id, 'owner'), filename = path.join(selected.rootPath, WORKSPACE_STARTER_DOCUMENT_NAME), before = await readFile(filename);
      const intent = await readWorkspaceStarterInitializationIntent(rawConnection(admin), id); assert(intent);
      assert.equal(intent.actorUserId, 'owner'); assert.equal(intent.sourceSha256, crypto.createHash('sha256').update(before).digest('hex'));
      const actual = await request(id === destination.workspaceId, 'owner', selected);
      assert.equal((await auth.api.getSession({ headers: actual.headers }))?.session.id, 'session-owner');
      const initialized = await initializeCreatedWorkspaceStarter(actual, id); assert(initialized);
      assert.equal(initialized.status, 'completed'); assert.equal(initialized.operationId, intent.operationId); assert.equal(initialized.requestId, intent.requestId);
      const rows = (await admin.query(`SELECT actor_user_id,actor_session_id,request_id,private_result,after_state_snapshot
        FROM collaboration_markdown_file_import_receipts WHERE workspace_id=$1 AND operation_id=$2`, [id, intent.operationId])).rows;
      assert.equal(rows.length, 1); assert.equal(rows[0].actor_user_id, 'owner'); assert.equal(rows[0].actor_session_id, 'session-owner');
      assert.equal(rows[0].request_id, intent.requestId); assert.equal(rows[0].private_result.sourceHash, intent.sourceSha256);
      const target = rows[0].private_result.target, state = await load(target.documentId);
      assert.equal(state.workspaceId, id); assert.equal(state.path, WORKSPACE_STARTER_DOCUMENT_NAME); assert.equal(state.lifecycleGeneration, 1);
      assert.equal(authoritativeNativeCollaborationSnapshot(state).version.stateProof, target.initialStateProof);
      assert.deepEqual(await readFile(filename), before, 'Real API initialization preserves every original physical starter byte.');
      const observation = await readWorkspaceLinkSourceAuthorityOnConnection(rawConnection(admin), selected);
      assert.equal(observation.stage.readiness, 'native-coordinator-required'); assert.equal(observation.stage.coverage.complete, true);
      assert(observation.stage.sources.every(value => value.kind === 'native'));
      assert.equal(observation.stage.namespace.find(value => value.path === WORKSPACE_STARTER_DOCUMENT_NAME)?.identity, `registry:${target.documentId}:1`);
      console.log(JSON.stringify({ initializer: 'actual-created-workspace-starter', workspaceId: id, status: initialized.status,
        operationId: intent.operationId, requestId: intent.requestId, originalImportReceipt: true, originalPhysicalBytes: true }));
    }
    for (const representation of ['plain_text', 'tiptap_xml', 'tiptap_blocks'] as const) {
      await group(`${representation}: genuine same-workspace native copy rewrites outgoing links and retains exact native metadata`, async () => {
        const original = await folder(destination, representation, { table: representation !== 'plain_text' });
        const targetPath = `same-${crypto.randomUUID()}/copied.md`;
        const job = await prepareJob([{ sourcePath: `${original.root}/note.md`, destinationPath: targetPath }]);
        assert(job.plan.nativePathPlan.mutations.length > 0, 'Fixture must actually require a fresh-clone link delta.');
        const result = await run(job), body = await assertComplete(job, result);
        assert.equal(body.documents.length, 1);
        const clone = await load(body.documents[0].clone.documentId), inventory = inspectPersistedDocumentLinks(clone);
        const literal = `../${original.root}/target.md#Heading`;
        assert(inventory.links.some(link => String(link.ref.kind === 'link-mark' ? link.ref.expected.href : link.ref.expected).includes(literal)),
          'Freshly opened clone resolves its original target from the new directory.');
        await missing(path.join(destination.rootPath, path.posix.dirname(targetPath)));
      });
      await group(`${representation}: real cross-workspace Cookie/Bearer copies a READ-only source with ALL native children and linkless clones`, async () => {
        const original = await folder(source, representation, { table: representation !== 'plain_text' });
        const equalSpelling = await seedNative(source, `${original.root}/relative-only.md`, representation,
          '[Relative](target.md#Heading)\n\nIndependent equal-spelling native link');
        const targetPath = `cross-${crypto.randomUUID()}`;
        assert.equal((await workspace(source.workspaceId)).permissions.canWrite, false);
        const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }], source, destination,
          { cookie: representation !== 'plain_text' });
        const result = await run(job), body = await assertComplete(job, result);
        assert.equal(body.documents.length, 4); assert(job.plan.nativePathPlan.mutations.length > 0);
        const emptyClone = body.documents.find(value => value.source.documentId === original.empty.state.documentId); assert(emptyClone);
        assert.equal((await load(emptyClone.clone.documentId)).documentSequence, 0, 'A linkless/empty clone needs no invented link mutation.');
        const unchangedClone = body.documents.find(value => value.source.documentId === equalSpelling.state.documentId); assert(unchangedClone);
        assert(job.plan.nativePathPlan.mutations.some(value => value.source.documentId === equalSpelling.state.documentId), 'Original Cross-WS planning still proves the equal-spelling link binding.');
        assert.equal((await load(unchangedClone.clone.documentId)).documentSequence, 0);
        assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_native_link_mutation_receipts WHERE document_id=$1', [unchangedClone.clone.documentId])).rows[0].n, 0);
        await missing(path.join(destination.rootPath, targetPath));
      });
    }
    await group('native-only implicit folder remains logical while the actual collector proves new registry identities', async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `virtual-${crypto.randomUUID()}/copied-folder`;
      await missing(path.join(destination.rootPath, original.root));
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      const before = io.readdirSync(destination.rootPath).filter(value => value.startsWith('.canvas-create-'));
      const body = await assertComplete(job, await run(job)); assert.equal(body.documents.length, 3);
      assert.deepEqual(io.readdirSync(destination.rootPath).filter(value => value.startsWith('.canvas-create-')), before);
      await missing(path.join(destination.rootPath, targetPath.split('/')[0]));
    });
    await group('mixed folder copies real PDF/image/empty-directory and omits exact stale native projections', async () => {
      const original = await folder(source, 'tiptap_blocks', { mixed: true, projection: true, table: true });
      const targetPath = `mixed-${crypto.randomUUID()}`;
      const sourceAsset = path.join(source.rootPath, original.root, 'assets/report.pdf'), sourceStat = await lstat(sourceAsset);
      const sourceProjection = await readFile(path.join(source.rootPath, original.root, 'note.md'));
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }], source, destination);
      await assertComplete(job, await run(job));
      for (const asset of ['assets/report.pdf', 'assets/pixel.png']) {
        assert.deepEqual(await readFile(path.join(destination.rootPath, targetPath, asset)), await readFile(path.join(source.rootPath, original.root, asset)));
      }
      const copiedAsset = await lstat(path.join(destination.rootPath, targetPath, 'assets/report.pdf'));
      assert.notEqual(`${copiedAsset.dev}:${copiedAsset.ino}`, `${sourceStat.dev}:${sourceStat.ino}`); assert.equal(copiedAsset.nlink, 1);
      assert.deepEqual(await readdir(path.join(destination.rootPath, targetPath, 'empty-directory')), []);
      assert.deepEqual(await readFile(path.join(source.rootPath, original.root, 'note.md')), sourceProjection);
      await missing(path.join(destination.rootPath, targetPath, 'note.md'));
    });
    await group('ALL clone births and actual fresh-link receipt share B/XID and outer failure rolls every domain row back', async () => {
      const original = await folder(destination, 'tiptap_blocks'), targetPath = `rollback-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      const failure = new Error('Owned actual link INSERT acknowledgement failed.'); let observed = false;
      await withProbe(async event => {
        if (observed || !/^\s*INSERT INTO collaboration_native_link_mutation_receipts\b/iu.test(event.text)) return;
        observed = true;
        const identity = (await event.raw('SELECT pg_backend_pid() AS pid,pg_current_xact_id_if_assigned()::text AS xid')).rows[0];
        const row = (await event.raw('SELECT private_result,xmin::text AS xmin FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
        assert(row); assert.equal(row.private_result.documents.length, 3);
        const ids = row.private_result.documents.map((value: NativeCopyReceipt['documents'][number]) => value.clone.documentId);
        const writes = (await event.raw(`SELECT xmin::text AS xmin FROM collaboration_documents WHERE id=ANY($1::text[])
          UNION ALL SELECT xmin::text FROM collaboration_yjs_states WHERE document_id=ANY($1::text[])
          UNION ALL SELECT xmin::text FROM collaboration_native_link_mutation_receipts WHERE document_id=ANY($1::text[])`, [ids])).rows;
        assert.equal(writes.length, 7); assert(writes.every(value => value.xmin === row.xmin));
        assert.equal(row.xmin, (BigInt(identity.xid) % BigInt('4294967296')).toString());
        assert.deepEqual(await stateCounts(job.operationId), { operations: 1, steps: 0, receipts: 0 }, 'Only the earlier B0 intent is visible outside B1; no clone or step is committed.');
        throw failure;
      }, () => interrupted(job, failure));
      assert(observed);
      assert.deepEqual(await stateCounts(job.operationId), { operations: 1, steps: 0, receipts: 0 });
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE workspace_id=$1 AND path LIKE $2',
        [destination.workspaceId, `${targetPath}/%`])).rows[0].n, 0);
      await missing(path.join(destination.rootPath, targetPath));
      await assertComplete(job, await run(job));
    });
    await group('source READ revocation after actual clone/link writes rejects and rolls back ACL, Journal, clone and link receipt together', async () => {
      const original = await folder(source, 'plain_text'), targetPath = `revoked-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }], source, destination); let revoked = false;
      await withProbe(async event => {
        if (revoked || !/^\s*INSERT INTO collaboration_native_link_mutation_receipts\b/iu.test(event.text)) return;
        revoked = true; await event.raw("UPDATE canvas_workspace_members SET can_read=0 WHERE workspace_id=$1 AND user_id='member'", [source.workspaceId]);
      }, async () => {
        await assert.rejects(run(job), domainFailure);
      });
      assert(revoked); assert.equal((await workspace(source.workspaceId)).permissions.canRead, true);
      assert.deepEqual(await stateCounts(job.operationId), { operations: 1, steps: 0, receipts: 0 });
      await missing(path.join(destination.rootPath, targetPath));
      await assertComplete(job, await run(job));
    });
    for (const acknowledgement of ['before', 'after'] as const) await group(`B1 COMMIT ${acknowledgement}-ACK failure preserves original intent and genuine recovery with a new current session`, async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `commit-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      let fired = false, originalCloneIds: string[] = [];
      const lost = Object.assign(new Error(`Owned ${acknowledgement} actual B1 COMMIT acknowledgement lost.`), { code: 'EIO' });
      const atCommit = async (event: Omit<SqlEvent, 'result'>) => {
        if (fired || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const row = (await event.raw('SELECT private_result,publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
        if (!row || row.publication_status !== 'native_committed') return;
        // No parent or path application has happened: this is actual B1.
        const state = (await event.raw('SELECT status FROM workspace_file_operation_steps WHERE operation_id=$1 AND phase=\'path\'', [job.operationId])).rows;
        if (!state.length || state.some(value => value.status === 'applied')) return;
        originalCloneIds = row.private_result.documents.map((value: NativeCopyReceipt['documents'][number]) => value.clone.documentId);
        fired = true; throw lost;
      };
      if (acknowledgement === 'before') beforeCommit = atCommit;
      try {
        await withProbe(event => acknowledgement === 'after' ? atCommit(event) : Promise.resolve(), () => interrupted(job, 'NATIVE_COPY_COMMIT_UNCONFIRMED'));
      } finally { beforeCommit = undefined; }
      assert(fired); const durable = await nativeStage(job); assert.equal(durable.physical.length, 1);
      const header = await journal.get(job.operationId); assert(header); assert.deepEqual(JSON.parse(header.requestJson).origin, job.origin);
      if (acknowledgement === 'before') {
        assert.deepEqual(await stateCounts(job.operationId), { operations: 1, steps: 0, receipts: 0 });
        assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_documents WHERE id=ANY($1::text[])', [originalCloneIds])).rows[0].n, 0);
      } else assert.deepEqual((await ledger(job.operationId)).private_result.documents.map(value => value.clone.documentId), originalCloneIds);
      const currentSessionId = await renewSession(); assert.notEqual(currentSessionId, job.origin.actor.sessionId); job.request = await request();
      const body = await assertComplete(job, await run(job));
      if (acknowledgement === 'after') assert.deepEqual(body.documents.map(value => value.clone.documentId), originalCloneIds, 'Recovery never repeats original committed native births.');
    });
    await group('durable actual parent ACK survives interruption and shared physical selections recover using original producer receipts', async () => {
      const root = `parents-${crypto.randomUUID()}`, targetPath = `born-${crypto.randomUUID()}`;
      await put(destination, `${root}/first.pdf`, 'first opaque asset'); await put(destination, `${root}/second.pdf`, 'second opaque asset');
      const job = await prepareJob([{ sourcePath: `${root}/first.pdf`, destinationPath: `${targetPath}/first.pdf` },
        { sourcePath: `${root}/second.pdf`, destinationPath: `${targetPath}/second.pdf` }]);
      let fired = false; const failure = new Error('Owned durable parent receipt COMMIT ACK lost.');
      await withProbe(async event => {
        if (fired || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const rows = (await event.raw("SELECT step_key,receipt_json FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key LIKE 'copy-parent:%' AND status='applied'", [job.operationId])).rows;
        if (!rows.length) return;
        fired = true; assert.equal((await lstat(path.join(destination.rootPath, targetPath))).isDirectory(), true);
        await missing(path.join(destination.rootPath, targetPath, 'first.pdf')); throw failure;
      }, () => interrupted(job, 'parent-create-unconfirmed'));
      assert(fired); const parent = await lstat(path.join(destination.rootPath, targetPath));
      const old = await journal.get(job.operationId); assert(old);
      const parentRows = old.steps.filter(value => value.stepKey.startsWith('copy-parent:') && value.status === 'applied'); assert.equal(parentRows.length, 1);
      const originalReceipt = parentRows[0].receiptJson;
      await assertComplete(job, await run(job));
      assert.equal((await lstat(path.join(destination.rootPath, targetPath))).ino, parent.ino);
      const completed = await journal.get(job.operationId); assert(completed);
      assert.equal(completed.steps.find(value => value.stepKey === parentRows[0].stepKey)?.receiptJson, originalReceipt);
      assert.equal(await readFile(path.join(destination.rootPath, targetPath, 'first.pdf'), 'utf8'), 'first opaque asset');
      assert.equal(await readFile(path.join(destination.rootPath, targetPath, 'second.pdf'), 'utf8'), 'second opaque asset');
    });
    await group('actual atomic FS publication followed by lost parent-fsync ACK preserves exact payload inode and recovers once', async () => {
      const name = `fs-${crypto.randomUUID()}.pdf`, targetPath = `copied-${crypto.randomUUID()}.pdf`;
      await put(destination, name, 'Durable opaque PDF bytes');
      const job = await prepareJob([{ sourcePath: name, destinationPath: targetPath }]);
      const descriptor = Object.getOwnPropertyDescriptor(io, 'fsync'); assert(descriptor);
      const actualSync = io.fsync.bind(io); let fired = false;
      Object.defineProperty(io, 'fsync', { ...descriptor, value: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => actualSync(fd, error => {
        if (!error && !fired && io.existsSync(path.join(destination.rootPath, targetPath))) {
          fired = true; callback(Object.assign(new Error('Owned actual publication fsync ACK lost.'), { code: 'EIO' }));
        } else callback(error);
      }) });
      try { await interrupted(job, 'publication-unconfirmed'); }
      finally { Object.defineProperty(io, 'fsync', descriptor); }
      assert(fired); const published = await lstat(path.join(destination.rootPath, targetPath));
      assert.equal(await readFile(path.join(destination.rootPath, targetPath), 'utf8'), 'Durable opaque PDF bytes');
      assert.equal((await ledger(job.operationId)).publication_status, 'native_committed');
      await assertComplete(job, await run(job));
      assert.equal((await lstat(path.join(destination.rootPath, targetPath))).ino, published.ino);
      assert.equal(await readFile(path.join(destination.rootPath, name), 'utf8'), 'Durable opaque PDF bytes');
    });
    await group('D2 appearing after B1 is preserved without overwrite or adoption and original staged payload remains recoverable', async () => {
      const name = `d2-${crypto.randomUUID()}.pdf`, targetPath = `target-${crypto.randomUUID()}.pdf`;
      await put(destination, name, 'Original source bytes'); const job = await prepareJob([{ sourcePath: name, destinationPath: targetPath }]);
      let inserted = false;
      await withProbe(async event => {
        if (inserted || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const row = (await event.raw('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
        if (!row || row.publication_status !== 'native_committed') return;
        inserted = true; await put(destination, targetPath, 'Foreign D2 stays exact');
      }, () => interrupted(job, 'recovery-conflict'));
      assert(inserted); const d2 = await lstat(path.join(destination.rootPath, targetPath)), saved = path.join(dataRoot, `saved-${crypto.randomUUID()}.pdf`);
      assert.equal(await readFile(path.join(destination.rootPath, targetPath), 'utf8'), 'Foreign D2 stays exact');
      const stageData = await nativeStage(job), original = stageData.physical[0].original; assert(original.staging);
      const payload = path.join(destination.rootPath, original.staging.relativePath, 'payload');
      assert.equal(await readFile(payload, 'utf8'), 'Original source bytes');
      await rename(path.join(destination.rootPath, targetPath), saved);
      assert.equal((await lstat(saved)).ino, d2.ino); assert.equal(await readFile(saved, 'utf8'), 'Foreign D2 stays exact');
      await assertComplete(job, await run(job));
      assert.equal(await readFile(path.join(destination.rootPath, targetPath), 'utf8'), 'Original source bytes');
      assert.equal(await readFile(saved, 'utf8'), 'Foreign D2 stays exact');
    });
    await group('complete final-graph validation refuses an unrelated namespace candidate instead of accepting a selected-subgraph match', async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `graph-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      const extra = `unrelated-${crypto.randomUUID()}.pdf`; let inserted = false;
      await withProbe(async event => {
        if (inserted || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const row = (await event.raw('SELECT publication_status FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0];
        if (!row || row.publication_status !== 'native_committed') return;
        inserted = true; await put(destination, extra, 'Unrelated D2 candidate must remain');
      }, () => interrupted(job, 'NATIVE_COPY_FINAL_GRAPH_CHANGED'));
      assert(inserted); assert.equal((await ledger(job.operationId)).publication_status, 'native_committed');
      assert.equal(await readFile(path.join(destination.rootPath, extra), 'utf8'), 'Unrelated D2 candidate must remain');
      await rename(path.join(destination.rootPath, extra), path.join(dataRoot, extra));
      await assertComplete(job, await run(job));
    });
    await group('completed retry after later legitimate native edit and physical S2/D2 reads original history without replaying any mutation', async () => {
      const original = await folder(destination, 'tiptap_blocks', { mixed: true, table: true }), targetPath = `history-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      const body = await assertComplete(job, await run(job));
      const copied = body.documents.find(value => value.source.documentId === original.note.state.documentId); assert(copied);
      const before = await load(copied.clone.documentId), document = new Y.Doc();
      try {
        Y.applyUpdate(document, before.yjsState);
        const frontmatter = document.getText('frontmatter'); frontmatter.delete(0, frontmatter.length);
        frontmatter.insert(0, '---\r\ntitle: Later legitimate native text\r\n---\r\n');
        const result = await persistCollaborationYDoc(before.documentId, before.lifecycleGeneration, document, {
          workspaceId: before.workspaceId, organizationId: before.organizationId, path: before.path,
          representation: before.representation, schemaVersion: before.schemaVersion });
        assert.equal(result.persistenceDisposition, 'advanced');
      } finally { document.destroy(); }
      const savedTarget = path.join(dataRoot, `historical-target-${crypto.randomUUID()}`), savedSource = path.join(dataRoot, `historical-source-${crypto.randomUUID()}`);
      await rename(path.join(destination.rootPath, targetPath), savedTarget); await put(destination, `${targetPath}/D2.pdf`, 'Historical D2 must stay');
      await rename(path.join(destination.rootPath, original.root), savedSource); await put(destination, `${original.root}/S2.pdf`, 'Historical S2 must stay');
      const d2 = await lstat(path.join(destination.rootPath, targetPath, 'D2.pdf')), s2 = await lstat(path.join(destination.rootPath, original.root, 'S2.pdf'));
      const stateBefore = (await admin.query('SELECT row_to_json(s)::text AS body FROM collaboration_yjs_states s WHERE document_id=$1', [before.documentId])).rows[0].body;
      const operationBefore = await journal.get(job.operationId), receiptsBefore = (await ledger(job.operationId)).private_result;
      let domainWrites = 0, readOnlyQueries = 0; const historicalClients = new Set<PoolClient>();
      const retry = await withProbe(async event => {
        if (/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(event.text)) domainWrites++;
        if (/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/iu.test(event.text)) historicalClients.add(event.client);
        if (historicalClients.has(event.client)) {
          assert(!/FOR\s+(?:UPDATE|SHARE)|pg_current_xact_id\s*\(/iu.test(event.text));
          assert(!/(?:FROM|JOIN)\s+(?:"?\w+"?\.)?"?(?:collaboration_yjs_states|collaboration_documents|file_collaboration_lineages)\b/iu.test(event.text), 'Completed history must not require current native rows.');
          assert.equal((await event.raw('SELECT pg_current_xact_id_if_assigned()::text AS xid')).rows[0].xid, null);
          readOnlyQueries++;
          if (/^COMMIT$/iu.test(event.text)) historicalClients.delete(event.client);
        }
      }, () => run(job));
      assert.equal(retry.execution.status, 'complete'); assert.equal(retry.alreadyKnown, true); assert.equal(domainWrites, 0);
      assert(readOnlyQueries > 3); assert.equal(historicalClients.size, 0);
      assert.deepEqual(await journal.get(job.operationId), operationBefore); assert.deepEqual((await ledger(job.operationId)).private_result, receiptsBefore);
      assert.equal((await admin.query('SELECT row_to_json(s)::text AS body FROM collaboration_yjs_states s WHERE document_id=$1', [before.documentId])).rows[0].body, stateBefore);
      assert.equal((await lstat(path.join(destination.rootPath, targetPath, 'D2.pdf'))).ino, d2.ino);
      assert.equal((await lstat(path.join(destination.rootPath, original.root, 'S2.pdf'))).ino, s2.ino);
      assert.equal(await readFile(path.join(destination.rootPath, targetPath, 'D2.pdf'), 'utf8'), 'Historical D2 must stay');
      assert.equal(await readFile(path.join(destination.rootPath, original.root, 'S2.pdf'), 'utf8'), 'Historical S2 must stay');
    });

    const { MAIN_AGENT_ID } = await import('../app/lib/agents/main-agent');
    await admin.query(`INSERT INTO agents(agent_id,name,type,access_policy,scope_type,organization_id,enabled_tools_json,created_at,updated_at)
      VALUES($1,'System','main','legacy','organization','principal-org','["copy_path"]',100,100),
      ('copy-special','Copy special','special','restricted','organization','principal-org','["copy_path"]',100,100)
      ON CONFLICT(agent_id) DO UPDATE SET enabled_tools_json=excluded.enabled_tools_json`, [MAIN_AGENT_ID]);
    await admin.query(`INSERT INTO agent_members(agent_id,organization_id,user_id,status,can_use,created_at,updated_at)
      VALUES('copy-special','principal-org','owner','active',1,100,100),('copy-special','principal-org','member','inactive',0,100,100)`);
    await admin.query(`INSERT INTO agent_grants(id,agent_id,organization_id,target_type,target_id,can_use,created_at,updated_at)
      VALUES('copy-grant','copy-special','principal-org','workspace',$1,1,100,100)`, [destination.workspaceId]);
    const seedPi = async (sessionId: string, userId: string, agentId: string) => admin.query(`INSERT INTO pi_sessions(session_id,user_id,agent_id,provider,model,organization_id,workspace_id,
      workspace_type,workspace_name,workspace_root_relative_path,created_at,updated_at)
      VALUES($1,$2,$3,'fixture','fixture','principal-org',$4,'team','Copy destination',$5,100,100)`,
    [sessionId, userId, agentId, destination.workspaceId, destination.rootRelativePath]);
    await seedPi('pi-current-special', 'member', 'copy-special'); await seedPi('pi-original-special', 'member', 'copy-special');
    await seedPi('pi-current-main', 'owner', MAIN_AGENT_ID);
    const { runWithAgentExecutionContext } = await import('../app/lib/pi/agent-execution-context');
    const { withAgentToolInvocation } = await import('../app/lib/pi/agent-tool-invocation');
    const agentContext = async (special = true): Promise<AgentExecutionContext> => {
      const selected = await workspace(destination.workspaceId, special ? 'member' : 'owner');
      return { userId: special ? 'member' : 'owner', sessionId: special ? 'pi-current-special' : 'pi-current-main',
        agentId: special ? 'copy-special' : null, agentTurnId: 'copy-owner-turn', workspaceId: selected.workspaceId,
        workspaceType: selected.workspaceType, workspaceName: selected.displayName ?? null,
        organizationId: selected.organizationId ?? null, customerId: selected.customerId ?? null, projectId: selected.projectId ?? null,
        workspaceRoot: selected.rootPath, workspaceRootRelativePath: selected.rootRelativePath ?? null,
        canWrite: false, canDelete: false, canShare: false, legacy: false };
    };
    const agentOrigin = async (special = true) => {
      const selected = await workspace(destination.workspaceId, special ? 'member' : 'owner');
      return captureWorkspaceOperationCopyOrigin({ actor: { type: 'agent', userId: special ? 'member' : 'owner',
        actorId: special ? 'copy-special' : MAIN_AGENT_ID, sessionId: special ? 'pi-current-special' : 'pi-current-main' },
      sourceWorkspace: selected, destinationWorkspace: selected });
    };
    const invoke = async <T>(operation: () => Promise<T>, special = true, abort?: AbortController) => {
      const selected = await agentContext(special);
      return runWithAgentExecutionContext(selected, () => withAgentToolInvocation(selected,
        { toolName: 'copy_path', toolCallId: `copy-owner-${crypto.randomUUID()}`, signal: abort?.signal }, operation));
    };
    await group('genuine restricted and default PI copy_path invocations create native documents using original agent/session pins', async () => {
      for (const special of [true, false]) {
        const original = await folder(destination, 'plain_text'), targetPath = `pi-${crypto.randomUUID()}`;
        const origin = await agentOrigin(special), selected = await workspace(destination.workspaceId, special ? 'member' : 'owner');
        console.log(JSON.stringify({ diagnostic: 'native-copy-owner-pi-phase', agent: special ? 'restricted' : 'default', phase: 'before-preview' }));
        const job = await invoke(() => prepareJob([{ sourcePath: original.root, destinationPath: targetPath }], selected, selected,
          { origin, agent: true }), special);
        console.log(JSON.stringify({ diagnostic: 'native-copy-owner-pi-phase', agent: special ? 'restricted' : 'default', phase: 'before-execute' }));
        const result = await invoke(() => run(job), special); await assertComplete(job, result);
        const row = await ledger(job.operationId); assert.equal(row.actor_user_id, special ? 'member' : 'owner');
        assert.equal(row.actor_session_id, origin.actor.sessionId);
        const links = (await admin.query(`SELECT DISTINCT actor_id,actor_type,actor_session_id FROM collaboration_native_link_mutation_receipts
          WHERE document_id=ANY($1::text[])`, [row.private_result.documents.map(value => value.clone.documentId)])).rows;
        assert.equal(links.length, 1); assert.deepEqual(links[0], { actor_id: origin.actor.actorId, actor_type: 'agent', actor_session_id: origin.actor.sessionId });
      }
    });
    await group('actor/scope/plan/session substitution and plain agent ALS cannot start the real writer or create a staging authority', async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `denied-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      const noWritesBefore = writeWitnesses.length;
      const conflict = (error: unknown) => error instanceof Error && !(error instanceof assert.AssertionError)
        && [401, 403, 409].includes(Number(Reflect.get(error, 'status')));
      for (const changed of [
        { ...job, expectedPlanId: 'f'.repeat(64) },
        { ...job, origin: { ...job.origin, actor: { ...job.origin.actor, actorId: 'another-actor' } } },
        { ...job, origin: { ...job.origin, sourceScope: { ...job.origin.sourceScope, rootPath: path.join(dataRoot, 'foreign-root') } } },
      ]) await assert.rejects(run(changed), conflict);
      assert.equal(writeWitnesses.length, noWritesBefore); assert.deepEqual(await stateCounts(job.operationId), { operations: 0, steps: 0, receipts: 0 });
      assert.equal(await staging.readKind(job.operationId), null); await missing(path.join(destination.rootPath, targetPath));
      const piOrigin = await agentOrigin(), selected = await agentContext();
      await assert.rejects(runWithAgentExecutionContext(selected, () => preview({ origin: piOrigin, selections: job.selections })), domainFailure);
      const connection = await db.openDb();
      try {
        const { assertNativeCopySessionOnConnection } = await import('../app/lib/files/workspace-operation-native-copy-owner');
        await assert.rejects(assertNativeCopySessionOnConnection(connection, job.origin), error => errorHas(error, 'NATIVE_COPY_OWNER_REQUIRED'));
      } finally { await connection.close(); }
    });
    await group('reviewed collision resolution keeps original D2 and the fixed Copy destination stable across execution and retry', async () => {
      const name = `collision-${crypto.randomUUID()}.pdf`; await put(destination, name, 'Original opaque bytes');
      const targetPath = `occupied-${crypto.randomUUID()}.pdf`; await put(destination, targetPath, 'Existing D2');
      const d2 = await lstat(path.join(destination.rootPath, targetPath));
      const job = await prepareJob([{ sourcePath: name, destinationPath: targetPath }], destination, destination, { renameOnCollision: true });
      assert.notEqual(job.selections[0].destinationPath, targetPath);
      await assertComplete(job, await run(job));
      assert.equal((await lstat(path.join(destination.rootPath, targetPath))).ino, d2.ino);
      assert.equal(await readFile(path.join(destination.rootPath, targetPath), 'utf8'), 'Existing D2');
      const repeated = await run(job); assert.equal(repeated.alreadyKnown, true); assert.equal(repeated.execution.status, 'complete');
      assert.equal(await readFile(path.join(destination.rootPath, job.selections[0].destinationPath), 'utf8'), 'Original opaque bytes');
    });
    await group('projection-absent first selection consumes a real shared parent born by the later physical producer', async () => {
      const nativeName = `absence-${crypto.randomUUID()}.md`, assetName = `physical-${crypto.randomUUID()}.pdf`, targetPath = `shared-${crypto.randomUUID()}`;
      await seedNative(destination, nativeName, 'plain_text', 'Linkless original native'); await put(destination, assetName, 'Shared parent asset');
      const job = await prepareJob([{ sourcePath: nativeName, destinationPath: `${targetPath}/native.md` },
        { sourcePath: assetName, destinationPath: `${targetPath}/asset.pdf` }]);
      let actualStage: WorkspaceOperationNativeCopyStage | undefined;
      await withProbe(async event => {
        if (actualStage || !/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text)) return;
        actualStage = await nativeStage(job);
        const { nativeCopyPhaseParentSteps } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
        const parents = nativeCopyPhaseParentSteps(actualStage);
        assert.equal(parents.length, 1); assert.equal(parents[0].producerSelectionIndex, 1);
        assert.deepEqual(parents[0].consumerSelectionIndexes, [0, 1]);
        assert.equal(actualStage.physical[0].original.staging, null); assert(actualStage.physical[1].original.staging);
      }, async () => { await assertComplete(job, await run(job)); });
      assert(actualStage); await missing(path.join(destination.rootPath, targetPath, 'native.md'));
      assert.equal(await readFile(path.join(destination.rootPath, targetPath, 'asset.pdf'), 'utf8'), 'Shared parent asset');
      const operation = await journal.get(job.operationId); assert(operation);
      assert.equal(operation.steps.filter(value => value.stepKey.startsWith('copy-parent:')).length, 1);
    });
    await group('completed history rejects a changed completion fence, unknown journal step and original-session substitution', async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `tamper-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      await assertComplete(job, await run(job));
      const operation = await journal.get(job.operationId); assert(operation);
      const completion = operation.steps.find(value => value.stepKey === 'copy-completion'); assert(completion);
      try {
        await admin.query('UPDATE workspace_file_operation_steps SET before_fence=$3 WHERE operation_id=$1 AND step_key=$2',
          [job.operationId, completion.stepKey, 'f'.repeat(64)]);
        await assert.rejects(run(job), error => errorHas(error, 'NATIVE_COPY_PHASE_CHANGED'));
      } finally {
        await admin.query('UPDATE workspace_file_operation_steps SET before_fence=$3 WHERE operation_id=$1 AND step_key=$2',
          [job.operationId, completion.stepKey, completion.beforeFence]);
      }
      try {
        await admin.query(`INSERT INTO workspace_file_operation_steps(operation_id,step_key,phase,status,before_fence,after_fence,receipt_json,created_at,updated_at)
          VALUES($1,'unrelated-step','link','applied','before','after','{}',100,100)`, [job.operationId]);
        await assert.rejects(run(job), error => errorHas(error, 'NATIVE_COPY_PHASE_CHANGED'));
      } finally { await admin.query("DELETE FROM workspace_file_operation_steps WHERE operation_id=$1 AND step_key='unrelated-step'", [job.operationId]); }
      try {
        // A new authenticated recovery session is legal. Replacing the actual
        // saved original session and rehashing its C2 request is not legal.
        const changed = JSON.parse(operation.requestJson); changed.origin.actor.sessionId = 'forged-original-session';
        const serialized = serializeWorkspaceOperationRequest(changed);
        await admin.query('UPDATE workspace_file_operations SET request_json=$2,request_hash=$3 WHERE operation_id=$1',
          [job.operationId, serialized.requestJson, serialized.requestHash]);
        await assert.rejects(run(job), error => errorHas(error, 'NATIVE_COPY_PHASE_CHANGED'));
      } finally { await admin.query('UPDATE workspace_file_operations SET request_json=$2,request_hash=$3 WHERE operation_id=$1',
        [job.operationId, operation.requestJson, operation.requestHash]); }
      assert.equal((await run(job)).execution.status, 'complete'); assert.deepEqual(await journal.get(job.operationId), operation);
    });
    await group('cross-workspace equal-path linkless source cannot be replaced by an independent original destination record in a receipt', async () => {
      const filename = `same-path-${crypto.randomUUID()}.md`, targetPath = `different-${crypto.randomUUID()}.md`;
      const original = await seedNative(source, filename, 'plain_text', 'Equal linkless content');
      const unrelated = await seedNative(destination, filename, 'plain_text', 'Equal linkless content');
      const job = await prepareJob([{ sourcePath: filename, destinationPath: targetPath }], source, destination);
      assert.equal(job.plan.nativePathPlan.mutations.length, 0); let checked = false;
      await withProbe(async event => {
        if (checked || !/^\s*INSERT INTO collaboration_native_copy_receipts\b/iu.test(event.text)) return;
        const stageData = await nativeStage(job);
        const row = (await event.raw('SELECT private_result FROM collaboration_native_copy_receipts WHERE operation_id=$1', [job.operationId])).rows[0]; assert(row);
        const receipt: NativeCopyReceipt = { ...structuredClone(row.private_result), publicationStatus: 'native_committed' };
        assert.equal(receipt.documents[0].source.documentId, original.state.documentId);
        const version = authoritativeNativeCollaborationSnapshot(unrelated.state).version;
        receipt.documents[0].source = { documentId: unrelated.state.documentId, lifecycleGeneration: unrelated.state.lifecycleGeneration,
          stateProof: version.stateProof, documentSequence: unrelated.state.documentSequence };
        const { assertNativeCopyPhaseReceipt } = await import('../app/lib/files/workspace-operation-native-copy-phase-contract');
        assert.throws(() => assertNativeCopyPhaseReceipt(stageData, receipt), error => errorHas(error, 'NATIVE_COPY_PHASE_CHANGED'));
        checked = true;
      }, async () => {
        const body = await assertComplete(job, await run(job)); assert.equal(body.documents[0].source.documentId, original.state.documentId);
      });
      assert(checked);
    });
    await group('an actual C3 birth committed in a separate earlier transaction cannot mint fresh B1 link authority', async () => {
      const original = await folder(destination, 'plain_text'), targetPath = `prior-birth-${crypto.randomUUID()}`;
      const job = await prepareJob([{ sourcePath: original.root, destinationPath: targetPath }]);
      let inserted: NativeCopyReceipt | undefined, priorXid: string | undefined;
      const { persistNativeWorkspaceCopiesOnConnection } = await import('../app/lib/collaboration/native-copy-persistence');
      await withProbe(async event => {
        if (inserted || !/^\s*COMMIT\s*$/iu.test(event.text)) return;
        const header = (await event.raw('SELECT status FROM workspace_file_operations WHERE operation_id=$1', [job.operationId])).rows[0];
        if (!header || header.status !== 'prepared') return;
        assert.equal((await event.raw('SELECT count(*)::integer AS n FROM workspace_file_operation_steps WHERE operation_id=$1', [job.operationId])).rows[0].n, 0);
        const stageData = await nativeStage(job), records = new Map(stageData.nativeRecords.map(value => [value.state.documentId, value]));
        // Actual adversarial precondition, not a fake receipt or principal:
        // commit the original C3 DAL on an independent explicit transaction of
        // this owned backend before the fixed owner begins B1. This mechanical
        // DAL call confers no authority on the later B1 fresh-link phase.
        await event.raw('BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE'); let committed = false;
        const connection: SqlConnection = {
          get: async (text, values) => (await event.raw(text, values)).rows[0],
          all: async (text, values) => (await event.raw(text, values)).rows,
          run: async (text, values) => ({ changes: (await event.raw(text, values)).rowCount ?? 0 }),
          close: () => assert.fail('The adversarial borrowed C3 call cannot close its caller backend.'),
        };
        try {
          priorXid = (await event.raw('SELECT pg_current_xact_id()::text AS xid')).rows[0].xid;
          const current = await workspace(destination.workspaceId);
          inserted = await persistNativeWorkspaceCopiesOnConnection(connection, { operationId: job.operationId,
            actorUserId: job.origin.actor.userId, actorSessionId: job.origin.actor.sessionId, kind: 'native_clone',
            sourceWorkspace: current, targetWorkspace: current, targetScopes: job.selections.map(value => value.destinationPath),
            copies: job.plan.nativePathPlan.pathMappings.filter(value => value.source.documentId !== null).map(value => {
              const source = records.get(value.source.documentId!); assert(source); return { source, targetPath: value.destinationPath };
            }), expectedTargets: [], publicationFingerprint: stageData.payloadSha256 });
          await event.raw('COMMIT'); committed = true;
        } finally { if (!committed) await event.raw('ROLLBACK'); }
      }, () => interrupted(job, 'NATIVE_COPY_PHASE_CHANGED'));
      assert(inserted); assert(priorXid);
      const row = await ledger(job.operationId); assert.equal(row.publication_status, 'native_committed');
      const { publicationStatus: _status, ...body } = inserted; assert.deepEqual(row.private_result, body);
      const ids = inserted.documents.map(value => value.clone.documentId); assert.equal(ids.length, 3);
      const births = (await admin.query('SELECT xmin::text AS xmin FROM collaboration_documents WHERE id=ANY($1::text[])', [ids])).rows;
      assert.equal(births.length, 3); assert(births.every(value => value.xmin === (BigInt(priorXid!) % BigInt('4294967296')).toString()));
      assert.equal((await admin.query('SELECT count(*)::integer AS n FROM collaboration_native_link_mutation_receipts WHERE document_id=ANY($1::text[])', [ids])).rows[0].n, 0);
      await missing(path.join(destination.rootPath, targetPath));
    });
    assert.equal(groups, 25); assert.equal(fetches, 0); assertClosedFds();
    console.log(JSON.stringify({ assertions: 'workspace-operation-native-copy-owner', groups, actualWriteWitnesses: writeWitnesses.length,
      actualBackendCount: new Set(writeWitnesses.map(value => value.pid)).size, initialReceiptBodies: initialBodies.size,
      measuredTransactions: measurementSequence, transactionCountUnit: 'actual-query-dispatch', timingBucketsOverlap: true,
      finishedTransactions: finishedMeasurements, failedTransactions: failedMeasurements }));
  } catch (error) { failed = true; primary = error; }
  finally {
    const cleanup: unknown[] = [];
    for (const restore of restorers.reverse()) try { restore(); } catch (error) { cleanup.push(error); }
    globalThis.fetch = originalFetch;
    try { await pool?.end(); } catch (error) { cleanup.push(error); }
    for (const client of [...clients]) try { await endClient(client); } catch (error) { cleanup.push(error); }
    try {
      assert.equal((await control.query('SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].count, 0);
      if (created) {
        const identity = (await control.query(`SELECT oid::text AS oid,pg_get_userbyid(nspowner)=current_user AS owned,
          obj_description(oid,'pg_namespace') AS marker FROM pg_namespace WHERE nspname=$1`, [schema])).rows[0];
        assert.equal(identity?.oid, schemaOid); assert.equal(identity?.owned, true); assert.equal(identity?.marker, applicationName);
        await control.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.equal((await control.query('SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname=$1 OR oid::text=$2', [schema, schemaOid])).rows[0].count, 0);
      }
    } catch (error) { cleanup.push(error); }
    try { await control.end(); } catch (error) { cleanup.push(error); }
    try {
      const current = await lstat(dataRoot); assert.equal(current.dev, dataIdentity.dev); assert.equal(current.ino, dataIdentity.ino); assert.equal(current.uid, dataIdentity.uid);
      await rm(dataRoot, { recursive: true }); await assert.rejects(lstat(dataRoot), { code: 'ENOENT' });
    } catch (error) { cleanup.push(error); }
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]; Object.assign(process.env, environment);
    for (const [filename, expected] of Object.entries(sourcePins)) try {
      assert.equal(crypto.createHash('sha256').update(await readFile(filename)).digest('hex'), expected, `Pinned source changed: ${filename}`);
    } catch (error) { cleanup.push(error); }
    if (cleanup.length) throw new AggregateError(failed ? [primary, ...cleanup] : cleanup, 'Owned native Copy integration fixture cleanup failed.');
    if (failed) throw primary;
  }
  assert.equal(opened, closed);
  console.log(JSON.stringify({ test: 'workspace-operation-native-copy-owner-postgres-test', groups, schema, schemaOid, applicationName,
    schemaRemoved: true, poolClosed: true, clientsClosed: true, opened, closed, fetches, dataRemoved: true }));
  complete = true;
}

runWorkspaceNativeCopyOwnerPostgresFixture().catch(error => {
  console.error('Owned native Copy integration fixture failed:', JSON.stringify({ stage, diagnostic: ownerDiagnostic(error) }));
  process.exitCode = 1;
});
